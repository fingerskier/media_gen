import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  safeStorage,
  dialog,
  shell,
  session,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { Repository } from "./storage";
import { Credentials } from "./credentials";
import { Preferences } from "./preferences";
import { AtlasProvider, models, validateRecipe } from "./atlas";
import { createTransport, createCatalogFetch } from "./network";
import { Catalog } from "./catalog";
import { createDownloader, assetPath, serveFile, exportFile } from "./media";
import { JobRunner } from "./jobs";
import type { Snapshot } from "../shared/types";
import { z } from "zod";
process.umask(0o077);
app.setName("Media Gen");
// Chromium only maps desktops it recognizes to a keyring backend; anything else (Hyprland,
// sway, niri, ...) silently gets basic_text, which reports encryption as unavailable. Prefer
// libsecret there; MEDIA_GEN_PASSWORD_STORE (e.g. kwallet6, basic) overrides the choice.
if (process.platform === "linux") {
  const known = /gnome|kde|unity|xfce|cinnamon|mate|pantheon|deepin|ukui|lxqt/i;
  const store =
    process.env.MEDIA_GEN_PASSWORD_STORE ||
    (known.test(process.env.XDG_CURRENT_DESKTOP ?? "")
      ? undefined
      : "gnome-libsecret");
  if (store && /^[a-z0-9-]+$/.test(store))
    app.commandLine.appendSwitch("password-store", store);
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window: BrowserWindow | undefined;
  app.on("second-instance", () => {
    window?.show();
  });
  app
    .whenReady()
    .then(async () => {
      const root = process.env.MEDIA_GEN_HOME || app.getPath("userData");
      const db = new Repository(root);
      db.recover();
      // MEDIA_GEN_CATALOG=off keeps the app on the built-in list (used by offline smoke harnesses).
      const catalog = new Catalog(
        root,
        process.env.MEDIA_GEN_CATALOG === "off"
          ? undefined
          : createCatalogFetch(),
        models,
      );
      const preferences = new Preferences(root, catalog);
      const credentials = new Credentials(
        root,
        safeStorage,
        process.env.ATLASCLOUD_API_KEY,
      );
      const runner = new JobRunner(
        db,
        new AtlasProvider(createTransport(), catalog),
        () => credentials.get(),
        createDownloader(root),
        () => Date.now(),
        () => credentials.reference(),
      );
      const indexURL = pathToFileURL(join(__dirname, "index.html")).href;
      const id = z.string().uuid();
      const getAsset = (input: unknown) => {
        const asset = db.assets().find((a) => a.id === id.parse(input));
        if (!asset) throw Error("Asset not found");
        return asset;
      };
      protocol.handle("media", async (request) => {
        try {
          const url = new URL(request.url);
          if (url.host !== "asset") return new Response(null, { status: 404 });
          const asset = getAsset(url.pathname.slice(1));
          return serveFile(
            assetPath(root, asset.filename),
            asset.mime,
            request,
          );
        } catch {
          return new Response(null, { status: 404 });
        }
      });
      // Only this local main frame may call the narrow bridge. Never send raw errors.
      function handle(name: string, fn: (...args: any[]) => unknown) {
        ipcMain.handle(name, async (event, ...args) => {
          if (
            event.sender !== window?.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            event.senderFrame.url !== indexURL
          )
            throw Error("Untrusted application frame");
          try {
            return await fn(...args);
          } catch {
            throw Error(
              "Operation failed. Check your inputs, key storage, or local files.",
            );
          }
        });
      }
      const snapshot = (): Snapshot => ({
        modelDefaults: preferences.defaults(),
        jobs: db.jobs().map(({ outputs, remoteId, credentialRef, ...job }) => ({
          ...job,
          hasRemoteJob: Boolean(remoteId),
        })),
        assets: db.assets().map(({ filename, ...asset }) => ({
          ...asset,
          url: "media://asset/" + asset.id,
          missing: !existsSync(assetPath(root, filename)),
        })),
        models: catalog.models(),
        catalog: {
          entries: catalog.entries(),
          updated: catalog.updated(),
          refreshing: catalog.refreshing,
          online: catalog.online,
        },
        credentials: credentials.status(),
      });
      handle("snapshot", snapshot);
      handle("save-model-default", async (mode: unknown, model: unknown) => {
        // Resolving fetches the model's public schema once; the definition is then cached locally.
        await catalog.resolve(
          z.enum(["image", "video"]).parse(mode),
          z.string().max(400).parse(model),
        );
        preferences.save(mode, model);
      });
      handle("refresh-catalog", () => catalog.refresh());
      handle("enqueue", (token: unknown, recipe: unknown) => {
        if (!credentials.get()) throw Error("Configure Atlas first");
        return db.enqueue(
          id.parse(token),
          validateRecipe(recipe, catalog),
          credentials.reference(),
        ).id;
      });
      handle("save-key", (key: unknown) =>
        credentials.save(z.string().min(1).max(4096).parse(key)),
      );
      handle("clear-key", () => credentials.clear());
      handle("retry", (jobId: unknown) => runner.retry(id.parse(jobId)));
      handle("cancel-queued", (jobId: unknown) =>
        runner.cancelQueued(id.parse(jobId)),
      );
      handle("stop-tracking", (jobId: unknown) =>
        runner.stopTracking(id.parse(jobId)),
      );
      handle("export", async (assetId: unknown) => {
        const asset = getAsset(assetId);
        const response = await dialog.showSaveDialog(window!, {
          title: "Export original media",
          defaultPath:
            "media-gen-" + asset.id + "." + asset.filename.split(".").pop(),
        });
        if (response.canceled || !response.filePath) return false;
        await exportFile(assetPath(root, asset.filename), response.filePath);
        return true;
      });
      handle("reveal", (assetId: unknown) => {
        const asset = getAsset(assetId);
        shell.showItemInFolder(assetPath(root, asset.filename));
      });
      handle("open", async (assetId: unknown) => {
        const asset = getAsset(assetId);
        // openPath resolves with an error description instead of rejecting.
        const failure = await shell.openPath(assetPath(root, asset.filename));
        if (failure) throw Error(failure);
      });
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      window = new BrowserWindow({
        width: 1360,
        height: 880,
        minWidth: 980,
        minHeight: 660,
        backgroundColor: "#111517",
        title: "Media Gen",
        webPreferences: {
          preload: join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      if (catalog.stale())
        void catalog.refresh().catch(() => {
          /* Offline start keeps the cached or built-in list; Settings offers a manual refresh. */
        });
      const timer = setInterval(() => {
        void runner.tick().catch(() => {
          /* Never leak provider response/secret. Persisted state recovers on next launch. */
        });
      }, 2000);
      let quitting = false;
      window.on("close", (event) => {
        if (quitting) return;
        if (
          db
            .jobs()
            .some((j) =>
              ["queued", "submitting", "running", "downloading"].includes(
                j.state,
              ),
            )
        ) {
          const choice = dialog.showMessageBoxSync(window!, {
            type: "question",
            buttons: ["Keep open", "Close and pause tracking"],
            defaultId: 0,
            cancelId: 0,
            title: "Jobs are still active",
            message:
              "Submitted jobs may continue running and billing at Atlas.",
            detail:
              "Local tracking pauses when the app closes and resumes next time. Closing does not cancel remote generation.",
          });
          if (choice === 0) {
            event.preventDefault();
            return;
          }
        }
        quitting = true;
        clearInterval(timer);
      });
      app.on("will-quit", () => {
        clearInterval(timer);
        db.close();
      });
      await window.loadURL(indexURL);
    })
    .catch(() => {
      dialog.showErrorBox(
        "Media Gen could not start",
        "The local library could not be opened. Check storage permissions and that the library was not created by a newer version.",
      );
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
}
