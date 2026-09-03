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

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('patched idb companion must be built on macOS arm64');
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

    fs.writeFileSync(
      path.join(output, 'manifest.json'),
      JSON.stringify(
        {
          ...manifest,
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
