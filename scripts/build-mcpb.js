import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifestPath = join(root, 'mcpb', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.version !== packageJson.version) {
    throw new Error(
        `MCPB manifest version ${manifest.version} does not match package version ${packageJson.version}`
    );
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-ie-migration-vrt-mcpb-'));
const bundleRoot = join(temporaryRoot, 'bundle');
const outputDirectory = join(root, 'dist');
const output = join(outputDirectory, `mcp-ie-migration-vrt-${packageJson.version}.mcpb`);

function run(command, args, cwd = root) {
    const result = spawnSync(command, args, {
        cwd,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
    }
}

try {
    await mkdir(bundleRoot, { recursive: true });
    for (const path of [
        'bin',
        'config',
        'src',
        'LICENSE',
        'README.md',
        'package.json',
        'package-lock.json',
    ]) {
        await cp(join(root, path), join(bundleRoot, path), { recursive: true });
    }
    await mkdir(join(bundleRoot, 'docs'), { recursive: true });
    await cp(join(root, 'docs', 'mcpb-signing.md'), join(bundleRoot, 'docs', 'mcpb-signing.md'));
    await cp(join(root, 'docs', 'vrt-standard.md'), join(bundleRoot, 'docs', 'vrt-standard.md'));
    await cp(join(root, 'mcpb', 'icon.png'), join(bundleRoot, 'icon.png'));
    await mkdir(join(bundleRoot, 'scripts'), { recursive: true });
    await cp(join(root, 'scripts', 'windows'), join(bundleRoot, 'scripts', 'windows'), {
        recursive: true,
    });
    await cp(manifestPath, join(bundleRoot, 'manifest.json'));
    await cp(join(root, 'mcpb', '.mcpbignore'), join(bundleRoot, '.mcpbignore'));

    run('npm', ['ci', '--omit=dev', '--ignore-scripts'], bundleRoot);
    await mkdir(outputDirectory, { recursive: true });
    await rm(output, { force: true });
    run(
        process.execPath,
        [
            join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js'),
            'pack',
            bundleRoot,
            output,
        ],
        root
    );

    const metadata = { package: packageJson.name, version: packageJson.version, artifact: output };
    await writeFile(
        join(outputDirectory, 'mcpb-build.json'),
        `${JSON.stringify(metadata, null, 2)}\n`
    );
    console.error(`Created ${output}`);
} finally {
    await rm(temporaryRoot, { recursive: true, force: true });
}
