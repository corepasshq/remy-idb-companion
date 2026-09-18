import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(scriptsDir, 'idb-patched-manifest.json'), 'utf8'),
);
const proxy = process.env.REMY_HELPER_BUILD_PROXY?.trim();
const env = {
  ...process.env,
  // idb's `build.sh` generates each xcodeproj into a `mktemp -d` directory and
  // then rewrites the paths XcodeGen wrote there back to project-relative ones,
  // so it can copy the result in without xattrs. That rewrite matches on the
  // project's ABSOLUTE path, which assumes the source tree is not itself under
  // `$TMPDIR` -- and ours is, because this script unpacks upstream into
  // `mkdtemp(os.tmpdir())`. XcodeGen then emits a short `../<scratch>/source/…`
  // instead, the sed matches nothing, and the copied project resolves one level
  // too high: `Unable to open base configuration reference file
  // …/<scratch>/<scratch>/source/Configuration/Shared.xcconfig`, which fails the
  // very first target. The workaround exists for filesystems with no xattr
  // support (EdenFS); APFS has them, so upstream's own opt-out is the fix.
  XCODEGEN_STRIP_XATTRS: 'false',
  ...(proxy
    ? {
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        https_proxy: proxy,
        http_proxy: proxy,
      }
    : {}),
};

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, target, cwd) {
  run('curl', ['-L', '--fail', '--retry', '3', '-o', target, url], cwd);
}

// idb's own `build.sh` hardcodes `ARCHS=arm64` in `invoke_xcodebuild()` (its
// comment: "build arm64 only (no Intel/x86_64 slices)"). That line, not a
// missing upstream x64 build, is what makes this arm64-only: an arm64 host's
// Xcode can cross-compile x86_64 once that one line is patched. This is the
// map from the arch this script accepts to the ARCHS value xcodebuild wants.
const XCODEBUILD_ARCHS = { arm64: 'arm64', x64: 'x86_64' };

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('patched idb companion must be built on macOS');
  }
  const targetArch = process.argv[3] ?? process.arch;
  const xcodebuildArch = XCODEBUILD_ARCHS[targetArch];
  if (!xcodebuildArch) {
    throw new Error(
      `unsupported target arch ${targetArch}; expected one of ${Object.keys(XCODEBUILD_ARCHS).join(', ')}`,
    );
  }
  const output = path.resolve(process.argv[2] ?? 'build/idb-patched');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'remy-idb-source-'));
  const sourceArchive = path.join(scratch, 'idb.tar.gz');
  const source = path.join(scratch, 'source');
  fs.mkdirSync(source);
  try {
    download(
      `https://github.com/facebook/idb/archive/refs/tags/${manifest.upstream.tag}.tar.gz`,
      sourceArchive,
      scratch,
    );
    if (sha256(sourceArchive) !== manifest.upstream.sourceArchiveSha256) {
      throw new Error('idb source archive checksum mismatch');
    }
    run('tar', ['xzf', sourceArchive, '-C', source, '--strip-components=1']);
    for (const relative of manifest.patches) {
      run('patch', ['-p1', '-i', path.join(scriptsDir, relative)], source);
    }

    // Loosen upstream's hardcoded `ARCHS=arm64` to the target this run wants.
    // A no-op when targetArch is arm64; the only other value in
    // XCODEBUILD_ARCHS is x86_64.
    const buildScript = path.join(source, 'build.sh');
    const buildScriptSource = fs.readFileSync(buildScript, 'utf8');
    const archsSetting = 'ARCHS=arm64';
    if (!buildScriptSource.includes(archsSetting)) {
      throw new Error(
        `idb's build.sh no longer contains '${archsSetting}'; the cross-arch patch needs updating`,
      );
    }
    fs.writeFileSync(
      buildScript,
      buildScriptSource.replaceAll(archsSetting, `ARCHS=${xcodebuildArch}`),
    );

    // Build dependencies are intentionally provisioned by the helper CI and
    // fixed in the manifest. Building them inside every Remy release is slow,
    // network-sensitive and not a reproducible supply chain.
    for (const tool of [
      'xcodegen',
      'protoc',
      'protoc-gen-swift',
      'protoc-gen-grpc-swift',
    ]) {
      run('/usr/bin/which', [tool], source);
    }

    const generated = path.join(source, 'IDBGRPCSwift');
    fs.mkdirSync(generated, { recursive: true });
    run(
      'protoc',
      [
        '--proto_path=proto',
        '--swift_out=Visibility=Public:IDBGRPCSwift',
        '--grpc-swift_out=Visibility=Public:IDBGRPCSwift',
        '--plugin=protoc-gen-grpc-swift=' +
          execFileSync('/usr/bin/which', ['protoc-gen-grpc-swift'], {
            env,
            encoding: 'utf8',
          }).trim(),
        '--plugin=protoc-gen-swift=' +
          execFileSync('/usr/bin/which', ['protoc-gen-swift'], {
            env,
            encoding: 'utf8',
          }).trim(),
        'proto/idb.proto',
      ],
      source,
    );
    run('./build.sh', ['generate'], source);

    // XcodeGen currently expands the optional DERIVED_FILE_DIR source as a
    // malformed source-root-relative path. A checked-in BuildInfo source makes
    // the release identity deterministic and avoids that generated-path bug.
    const projectYml = path.join(source, 'Companion', 'project.yml');
    let project = fs.readFileSync(projectYml, 'utf8');
    const generatedSource =
      '      - path: $(DERIVED_FILE_DIR)/BuildInfo.swift\n' +
      '        optional: true\n' +
      '        type: file\n';
    if (project.split(generatedSource).length !== 3) {
      throw new Error('unexpected idb BuildInfo project shape');
    }
    project = project.replaceAll(
      generatedSource,
      '      - path: BuildInfo.swift\n',
    );
    fs.writeFileSync(projectYml, project);
    fs.writeFileSync(
      path.join(source, 'Companion', 'BuildInfo.swift'),
      `let kBuildDate = "${manifest.name}"\nlet kBuildTime = "reproducible"\n`,
    );
    run('./build.sh', ['generate'], source);
    // Build only the companion + host frameworks. The simulator-side REPL/HID
    // bridge resources are unrelated to framebuffer MJPEG and are not needed
    // by this narrow helper asset.
    run('./build.sh', ['build', 'idb_companion'], source);

    fs.rmSync(output, { recursive: true, force: true });
    fs.mkdirSync(output, { recursive: true });
    const binary = path.join(
      source,
      'Build',
      'Products',
      'Release',
      'idb_companion',
    );
    run('strip', [
      '-S',
      '-x',
      '-o',
      path.join(output, 'idb_companion'),
      binary,
    ]);
    fs.chmodSync(path.join(output, 'idb_companion'), 0o755);

    // arm64 Mach-O executables get an implicit linker-applied ad-hoc signature
    // on this toolchain; x86_64 ones do not, and idb's build.sh never calls
    // codesign itself. An unsigned binary still runs locally (this script's
    // own `--help` smoke test does not need one), but the helper CI verifies
    // with `codesign --verify`, and Remy's packaging re-signs everything with
    // the app's real identity anyway -- so an explicit ad-hoc signature here
    // just makes the intermediate artifact consistent across both arches.
    if (xcodebuildArch !== 'arm64') {
      run('codesign', [
        '--force',
        '--sign',
        '-',
        path.join(output, 'idb_companion'),
      ]);
    }

    fs.writeFileSync(
      path.join(output, 'manifest.json'),
      JSON.stringify(
        {
          ...manifest,
          arch: targetArch,
          builtBinarySha256: sha256(path.join(output, 'idb_companion')),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`[idb-patched] ready: ${output}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[idb-patched] ${error.stack ?? error}`);
  process.exitCode = 1;
});
