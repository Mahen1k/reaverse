import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const script = fileURLToPath(
  new URL("../../../scripts/ci/portable-build-cache.mjs", import.meta.url),
);
const first = { taskId: "compile", hash: "0123456789abcdef" };
const second = { taskId: "artifacts:skills", hash: "fedcba9876543210" };
const plan = { tasks: [first, second] };
const prefix = "rea-portable-build-v2-Linux-X64-toolchain";
const output = ".cache/ci-build-cache";

it.each([
  { cacheMaxAge: "7d", cacheMaxSize: "0" },
  { cacheMaxAge: "0", cacheMaxSize: "1B" },
])(
  "retains completed task entries through publication under $cacheMaxAge/$cacheMaxSize retention",
  async (retention) => {
    const root = await fixture();
    const environment = z
      .object({
        jobs: z.object({
          build: z.object({
            env: z.record(z.string(), z.string()).default({}),
          }),
        }),
      })
      .parse(
        parse(
          await readFile(
            new URL("../../../.github/workflows/ci.yml", import.meta.url),
            "utf8",
          ),
        ),
      ).jobs.build.env;
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "cache-fixture",
        private: true,
        packageManager: "npm@11.16.0",
        scripts: { build: "node build.mjs" },
      }),
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: "cache-fixture",
        lockfileVersion: 3,
        packages: { "": { name: "cache-fixture" } },
      }),
    );
    await writeFile(
      join(root, "turbo.json"),
      JSON.stringify({
        ...retention,
        tasks: { build: { inputs: ["build.mjs"], outputs: ["out.txt"] } },
      }),
    );
    await writeFile(
      join(root, "build.mjs"),
      'import {writeFileSync} from "node:fs";writeFileSync("out.txt", "verified output");',
    );
    const turbo = fileURLToPath(
      new URL("../../../node_modules/turbo/bin/turbo", import.meta.url),
    );
    const prepare = (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [turbo, "run", "build", ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            ...environment,
            TURBO_CACHE_DIR: join(root, ".turbo/cache"),
            TURBO_TELEMETRY_DISABLED: "1",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    prepare();
    const before = await inventory(root, ".turbo/cache");
    const old = new Date("2000-01-01T00:00:00Z");
    for (const [name] of before) {
      if (name === undefined) throw new Error("Missing cache file name");
      await utimes(join(root, ".turbo/cache", name), old, old);
    }
    const result = run(root, "snapshot", prepare("--dry=json"));
    expect(result.status, result.stderr).toBe(0);
    expect(await inventory(root, output)).toEqual(before);
    expect(await inventory(root, ".turbo/cache")).toEqual(before);
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe(
      "verified output",
    );
    const normalEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      TURBO_CACHE_DIR: join(root, ".turbo/cache"),
      TURBO_TELEMETRY_DISABLED: "1",
    };
    delete normalEnvironment.TURBO_CACHE_MAX_AGE;
    delete normalEnvironment.TURBO_CACHE_MAX_SIZE;
    const pruned = spawnSync(
      process.execPath,
      [turbo, "run", "build", "--dry=json"],
      {
        cwd: root,
        encoding: "utf8",
        env: normalEnvironment,
      },
    );
    expect(pruned.status, pruned.stderr).toBe(0);
    expect(await readdir(join(root, ".turbo/cache"))).toEqual([]);
    expect(await inventory(root, output)).toEqual(before);
  },
);

function run(root: string, mode: "key" | "snapshot", input: unknown = plan) {
  const result = spawnSync(process.execPath, [script, mode], {
    cwd: root,
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, BUILD_CACHE_PREFIX: prefix },
  });
  expect(result.error).toBeUndefined();
  return result;
}

async function fixture() {
  const root = await createTestTempDirectory("rea-ci-portable-cache-");
  await mkdir(join(root, ".turbo/cache"), { recursive: true });
  return root;
}

async function entry(root: string, hash: string, manifest = true) {
  for (const suffix of [
    ".tar.zst",
    "-meta.json",
    ...(manifest ? ["-manifest.json"] : []),
  ])
    await writeFile(
      join(root, ".turbo/cache", `${hash}${suffix}`),
      `${hash}${suffix}\n`,
    );
}

async function inventory(root: string, path: string) {
  const files = (await readdir(join(root, path))).sort();
  return Promise.all(
    files.map(async (name) => [
      name,
      await readFile(join(root, path, name), "hex"),
    ]),
  );
}

it("publishes only current task companions without changing the source cache or retaining old snapshots", async () => {
  const root = await fixture();
  await entry(root, first.hash);
  await entry(root, second.hash, false);
  await entry(root, "aaaaaaaaaaaaaaaa");
  const before = await inventory(root, ".turbo/cache");
  const result = run(root, "snapshot");
  expect(result.status, result.stderr).toBe(0);
  const current = before.filter(
    ([name]) => name?.startsWith(first.hash) || name?.startsWith(second.hash),
  );
  expect(await inventory(root, output)).toEqual(current);
  expect(JSON.parse(result.stdout)).toMatchObject({
    tasks: 2,
    files: 5,
    path: output,
  });
  expect(run(root, "snapshot", { tasks: [second] }).status).toBe(0);
  expect(await inventory(root, output)).toEqual(
    before.filter(([name]) => name?.startsWith(second.hash)),
  );
  expect(await inventory(root, ".turbo/cache")).toEqual(before);
});

it("retains existing cross-run keys independent of plan order and invalidates changed task hashes", async () => {
  const root = await fixture();
  const digest = createHash("sha256")
    .update(
      plan.tasks
        .map(({ taskId, hash }) => `${taskId}:${hash}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");
  const expected = `key=${prefix}-${digest}\nprefix=${prefix}-\n`;
  const result = run(root, "key");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(expected);
  expect(run(root, "key", { tasks: [second, first] }).stdout).toBe(expected);
  const changed = run(root, "key", {
    tasks: [first, { ...second, hash: "aaaaaaaaaaaaaaaa" }],
  });
  expect(changed.status, changed.stderr).toBe(0);
  expect(changed.stdout).not.toBe(expected);
});

it("rejects malformed or ambiguous plans in both commands and removes stale publication output", async () => {
  const root = await fixture();
  for (const invalid of [
    "not JSON",
    {},
    { tasks: [] },
    { tasks: [{ taskId: "compile" }] },
    { tasks: [{ ...first, hash: null }] },
    { tasks: [{ ...first, hash: "../outside" }] },
    { tasks: [first, { ...first, hash: second.hash }] },
  ]) {
    await mkdir(join(root, output), { recursive: true });
    await writeFile(join(root, output, "old-success"), "stale");
    for (const mode of ["key", "snapshot"] as const) {
      const result = run(root, mode, invalid);
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stdout).toBe("");
    }
    await expect(readdir(join(root, output))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

it("fails publication on a cold cache, missing companions or non-file entries, including after a partial copy", async () => {
  const root = await fixture();
  expect(run(root, "snapshot").status).not.toBe(0);
  await expect(readdir(join(root, output))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await entry(root, first.hash);
  for (const suffix of [".tar.zst", "-meta.json", "-manifest.json"]) {
    await entry(root, second.hash);
    const path = join(root, ".turbo/cache", `${second.hash}${suffix}`);
    await rm(path);
    if (suffix === "-manifest.json") await mkdir(path);
    const result = run(root, "snapshot");
    expect(result.status, result.stderr).not.toBe(0);
    await expect(readdir(join(root, output))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(path, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "rejects symlinked archives and optional manifests without copying their targets",
  async () => {
    const root = await fixture();
    const outside = join(root, "outside");
    await writeFile(outside, "must not publish");
    for (const suffix of [".tar.zst", "-manifest.json"]) {
      await entry(root, first.hash);
      const path = join(root, ".turbo/cache", `${first.hash}${suffix}`);
      await rm(path);
      await symlink(outside, path);
      const result = run(root, "snapshot", { tasks: [first] });
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("must be a regular file");
      await expect(readdir(join(root, output))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(outside, "utf8")).toBe("must not publish");
      await rm(path);
    }
  },
);
