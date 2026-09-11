// End-to-end Electron generation with an in-process HTTP fixture boundary.
// The test bootstrap replaces DNS/HTTPS before app load; it cannot call Atlas.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = await mkdtemp(join(tmpdir(), "media-gen-generation-fixture-"));
const clip = join(root, "fixture.mp4");
execFileSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=24",
  "-t",
  "1",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  "-y",
  clip,
]);
const fixtureImage = resolve("tests/fixtures/test-image.png"),
  main = resolve("dist/main.cjs"),
  log = join(root, "requests.json");
const bootstrap = join(root, "bootstrap.cjs");
await writeFile(
  bootstrap,
  `
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');const fs=require('node:fs');
const calls=[];require('node:dns/promises').lookup=async()=>[{address:'93.184.216.34',family:4}];
require('node:https').request=(url,options,callback)=>{
 const req=new EventEmitter();let body='';req.write=chunk=>{body+=chunk};req.destroy=error=>{if(error)req.emit('error',error);req.emit('close');};
 req.end=()=>setImmediate(()=>{
  try{
   let bytes,type='application/json';
   if(url.hostname==='api.atlascloud.ai'){
    if(options.method==='POST'){
     const input=JSON.parse(body);const kind=url.pathname.endsWith('/generateImage')?'image':'video';
     if(!['black-forest-labs/flux-dev','alibaba/wan-2.5/text-to-video'].includes(input.model))throw Error('Unexpected fixture model');
     calls.push({method:'POST',kind,parameters:input});bytes=Buffer.from(JSON.stringify({code:200,data:{id:'fixture-'+kind,status:'processing'}}));
    }else{const kind=url.pathname.endsWith('fixture-image')?'image':'video';calls.push({method:'GET',kind});bytes=Buffer.from(JSON.stringify({data:{status:'completed',outputs:['https://fixture-output.invalid/'+kind]}}));}
   }else if(url.hostname==='fixture-output.invalid'){
    if(options.headers?.Authorization)throw Error('API key leaked to output host');
    const image=url.pathname==='/image';type=image?'image/png':'video/mp4';bytes=fs.readFileSync(image?${JSON.stringify(fixtureImage)}:${JSON.stringify(clip)});calls.push({method:'DOWNLOAD',kind:image?'image':'video'});
   }else{throw Error('All real network is disabled in this fixture bootstrap');}
   fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(calls));
   const response=new PassThrough();response.statusCode=200;response.headers={'content-type':type,'content-length':String(bytes.length)};callback(response);response.end(bytes);req.emit('close');
  }catch(error){req.destroy(error)}
 });return req;
};
process.env.ATLASCLOUD_API_KEY='TEST-FIXTURE-NOT-A-REAL-KEY';
require(${JSON.stringify(main)});
`,
);
const app = await electron.launch({
  args: [
    bootstrap,
    "--ozone-platform=x11",
    "--user-data-dir=" + join(root, "electron-profile"),
  ],
  env: {
    ...process.env,
    MEDIA_GEN_HOME: root,
    ATLASCLOUD_API_KEY: "",
    MEDIA_GEN_CATALOG: "off",
  },
  timeout: 30000,
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Default image model", { exact: true })
    .selectOption("black-forest-labs/flux-dev");
  await page.waitForFunction(
    async () =>
      (await window.mediaGen.snapshot()).modelDefaults.image ===
      "black-forest-labs/flux-dev",
  );
  await page
    .getByLabel("Default video model", { exact: true })
    .selectOption("alibaba/wan-2.5/text-to-video");
  await page.waitForFunction(
    async () =>
      (await window.mediaGen.snapshot()).modelDefaults.video ===
      "alibaba/wan-2.5/text-to-video",
  );
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("TEST FIXTURE generated image — not AI output");
  await page
    .getByRole("button", { name: "Generate image", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector(".preview img")?.naturalWidth > 0,
    {},
    { timeout: 20000 },
  );
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("TEST FIXTURE generated video — not AI output");
  await page
    .getByRole("button", { name: "Generate video", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector(".preview video")?.readyState >= 2,
    {},
    { timeout: 20000 },
  );
  const snapshot = await page.evaluate(() => window.mediaGen.snapshot());
  assert.equal(snapshot.jobs.filter((j) => j.state === "ready").length, 2);
  assert.equal(snapshot.assets.length, 2);
  assert.equal(
    snapshot.jobs.find((j) => j.recipe.mode === "image").recipe.model,
    "black-forest-labs/flux-dev",
  );
  assert.equal(
    snapshot.jobs.find((j) => j.recipe.mode === "video").recipe.model,
    "alibaba/wan-2.5/text-to-video",
  );
  assert.ok(snapshot.jobs.every((j) => j.recipe.parameters.seed === -1));
  assert.ok(!JSON.stringify(snapshot).includes("TEST-FIXTURE-NOT-A-REAL-KEY"));
  assert.ok(snapshot.jobs.every((j) => !("credentialRef" in j)));
  const calls = JSON.parse(await readFile(log, "utf8"));
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);
  assert.equal(calls.filter((c) => c.method === "DOWNLOAD").length, 2);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/generation-fixture.png" });
  assert.deepEqual(errors, []);
  const report = {
    result: "PASS",
    kind: "HTTP FIXTURES — NOT LIVE ATLAS",
    library: root,
    checks: [
      "UI submit to adapter to durable job to local download",
      "new image/video auto-preview",
      "effective settings saved",
      "no retained key in renderer snapshot",
      "no duplicate paid submissions",
    ],
    calls,
  };
  await writeFile(
    "artifacts/generation-fixture-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error("Fixture library:", root);
  console.error(
    JSON.stringify(
      await (
        await app.firstWindow()
      ).evaluate(() => window.mediaGen.snapshot()),
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app.close();
}
