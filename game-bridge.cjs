const fs = require('node:fs/promises');
const { createReadStream, existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { gameAssembly, runtimeFolder, gameAssemblyPath, queueRuntimes } = require('./game-runtime.cjs');

const bridgeAssembly = 'CalculatorQueueBridge';
const localBridge = path.join(__dirname, bridgeAssembly + '.dll');
const packagedBridge = path.join(__dirname, 'vendor', 'calculator-queue-bridge.json');
const hasBridgeAssembly = () => existsSync(localBridge) || existsSync(packagedBridge);
const directQueueSkills = ['Woodcutting', 'Mining', 'Fishing', 'Cooking', 'Smithing', 'Crafting',
  'Fletching', 'Runecrafting', 'Beastcrafting', 'Firemaking', 'Hunting'];
async function verifyBridgeRuntime(file, signal) {
  const { size } = await fs.stat(file);
  if (![...queueRuntimes.values()].includes(size)) throw new Error('bridge-build');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 256 * 1024, signal })) hash.update(chunk);
  if (queueRuntimes.get(hash.digest('hex')) !== size) throw new Error('bridge-build');
}

function bridgeOverrides(original) {
  const lines = original.split(/\r?\n/);
  let dotnet = -1;
  for (const [index, line] of lines.entries()) {
    const section = /^\s*\[([^\]]+)\]\s*(?:;.*)?$/.exec(line);
    if (section) {
      if (dotnet >= 0) {
        lines.splice(index, 0, 'project/assembly_name="' + bridgeAssembly + '"');
        return lines.join('\n');
      }
      if (section[1] === 'dotnet') dotnet = index;
    } else if (dotnet >= 0 && /^\s*project\/assembly_name\s*=/.test(line)) {
      // Two custom managed entry points cannot share the same Godot project.
      const assembly = /=\s*"([^"]+)"\s*(?:;.*)?$/.exec(line)?.[1];
      if (assembly !== gameAssembly && assembly !== bridgeAssembly) throw new Error('bridge-override-conflict');
      lines[index] = 'project/assembly_name="' + bridgeAssembly + '"';
      return lines.join('\n');
    }
  }
  if (dotnet < 0) lines.push('[dotnet]');
  lines.push('project/assembly_name="' + bridgeAssembly + '"', '');
  return lines.join('\n');
}

async function stageLanguageDirectory(source, destination, stageFile) {
  await fs.mkdir(destination);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await stageLanguageDirectory(from, to, stageFile);
    else if (entry.isFile() || entry.isSymbolicLink()) {
      const resource = await fs.realpath(from);
      if ((await fs.stat(resource)).isFile()) await stageFile(resource, to);
    }
  }
}

async function stageGameBridge(game, directory, assemblyFile, stageFile = fs.link) {
  const source = path.join(game, runtimeFolder(gameAssembly));
  const destination = path.join(directory, runtimeFolder(bridgeAssembly));
  const original = await fs.readFile(path.join(game, 'override.cfg'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const overrides = bridgeOverrides(original.replace(/^\uFEFF/, ''));
  await fs.mkdir(destination, { recursive: true });
  const executable = path.join(directory, 'Melvor2.exe');
  await stageFile(await fs.realpath(path.join(game, 'Melvor2.exe')), executable);
  for (const entry of await fs.readdir(game, { withFileTypes: true })) {
    const from = path.join(game, entry.name);
    const to = path.join(directory, entry.name);
    if (/^(?:languages|locale)$/i.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
      const resource = await fs.realpath(from);
      if ((await fs.stat(resource)).isDirectory()) await stageLanguageDirectory(resource, to, stageFile);
    } else if (/\.(?:pck|po|mo|translation)$/i.test(entry.name) && (entry.isFile() || entry.isSymbolicLink())) {
      const resource = await fs.realpath(from);
      if ((await fs.stat(resource)).isFile()) await stageFile(resource, to);
    }
  }
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) await stageFile(path.join(source, entry.name), path.join(destination, entry.name));
  }
  const bridgeFile = path.join(destination, bridgeAssembly + '.dll');
  if (assemblyFile || existsSync(localBridge)) await fs.copyFile(assemblyFile ?? localBridge, bridgeFile);
  else {
    // Older updaters admit vendor JSON. Only the small bridge assembly is unpacked here.
    const { data, sha256 } = JSON.parse(await fs.readFile(packagedBridge, 'utf8'));
    if (typeof data !== 'string' || data.length > 175000) throw new Error('bridge-build');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.subarray(0, 2).toString() !== 'MZ' || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new Error('bridge-build');
    }
    await fs.writeFile(bridgeFile, bytes, { flag: 'wx' });
  }
  await fs.copyFile(path.join(source, gameAssembly + '.runtimeconfig.json'),
    path.join(destination, bridgeAssembly + '.runtimeconfig.json'));
  const metadata = JSON.parse(await fs.readFile(path.join(source, gameAssembly + '.deps.json'), 'utf8'));
  const library = bridgeAssembly + '/1.0.0';
  metadata.targets[metadata.runtimeTarget.name][library] = {
    dependencies: { [gameAssembly]: '1.0.0' }, runtime: { [bridgeAssembly + '.dll']: {} }
  };
  metadata.libraries[library] = { type: 'project', serviceable: false, sha512: '' };
  await fs.writeFile(path.join(destination, bridgeAssembly + '.deps.json'), JSON.stringify(metadata));
  await fs.writeFile(path.join(directory, 'override.cfg'), overrides);
  return executable;
}

function removeTemporaryBridgeDirectory(root, directory) {
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (/^melvor-queue-(?:session|direct)-[A-Za-z0-9]{6}$/.test(relative)) {
    return fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareLinkedGame(game, { signal, assemblyFile, link = fs.link, root: stagingRoot } = {}) {
  const installation = await fs.realpath(game);
  const root = stagingRoot ?? path.dirname(installation);
  signal?.throwIfAborted();
  const directory = await fs.mkdtemp(path.join(root, 'melvor-queue-direct-'));
  try {
    const executable = await stageGameBridge(installation, directory, assemblyFile, async (from, to) => {
      signal?.throwIfAborted();
      await link(from, to);
    });
    return { directory, executable, cleanup: () => removeTemporaryBridgeDirectory(root, directory) };
  } catch (error) {
    await removeTemporaryBridgeDirectory(root, directory);
    throw error;
  }
}

const linkFallbackErrors = new Set(['EPERM', 'EACCES', 'EROFS', 'ENOTSUP', 'EINVAL', 'EXDEV', 'EMLINK']);

async function closeInstalledGame(executable, linkedExecutable, signal) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $allowed = @($env:MELVOR_INSTALLED_EXE, $env:MELVOR_LINKED_EXE) | Where-Object { $_ }
    $games = @(Get-Process -Name Melvor2 -ErrorAction SilentlyContinue)
    $closing = @()
    foreach ($gameProcess in $games) {
      if ($gameProcess.HasExited) { continue }
      if (-not ($allowed -contains $gameProcess.Path)) { throw 'Unknown game executable' }
      $closing += $gameProcess
    }
    foreach ($gameProcess in $closing) {
      if ($gameProcess.HasExited) { continue }
      if (-not $gameProcess.CloseMainWindow() -and -not $gameProcess.HasExited) { throw 'Game window unavailable' }
      if (-not $gameProcess.WaitForExit(20000)) { throw 'Game did not exit' }
    }
  `;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, signal, timeout: 25000,
    env: { ...process.env, MELVOR_INSTALLED_EXE: executable, MELVOR_LINKED_EXE: linkedExecutable ?? '' }
  });
}

function createGameBridge(game) {
  let session;
  async function restart(signal) {
    await verifyBridgeRuntime(gameAssemblyPath(game), signal);
    await closeInstalledGame(path.join(game, 'Melvor2.exe'), session?.executable, signal);
    const previous = session?.child;
    if (previous && previous.exitCode === null && previous.signalCode === null) {
      await once(previous, 'exit', { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    }
    return connect(signal);
  }

  async function connect(signal) {
    if (session && session.child.exitCode === null && session.child.signalCode === null) {
      if (!session.ready) session.ready = await send('hello', {}, signal, 40000) === 'connected';
      if (!session.ready) throw new Error('bridge-unavailable');
      return session;
    }
    const assembly = gameAssemblyPath(game);
    signal.throwIfAborted();
    try {
      await verifyBridgeRuntime(assembly, signal);
    } catch (error) {
      if (signal.aborted || error.message === 'bridge-build') throw error;
      throw new Error('direct-link-failed', { cause: error });
    }
    const { stdout } = await promisify(execFile)('tasklist.exe', [
      '/FI', 'IMAGENAME eq Melvor2.exe', '/FO', 'CSV', '/NH'
    ], { windowsHide: true, signal, timeout: 5000 });
    if (/^"Melvor2\.exe"/im.test(stdout)) throw new Error('game-already-open');
    const localRoot = os.tmpdir();
    let stage;
    try {
      try {
        stage = await prepareLinkedGame(game, { signal });
      } catch (error) {
        if (signal.aborted || !linkFallbackErrors.has(error.code)) throw error;
        stage = await prepareLinkedGame(game, { signal, root: localRoot,
          link: (from, to) => fs.symlink(from, to, 'file') });
      }
      await verifyBridgeRuntime(path.join(stage.directory, runtimeFolder(bridgeAssembly), gameAssembly + '.dll'), signal);
    } catch (error) {
      await stage?.cleanup?.();
      if (signal.aborted || ['bridge-build', 'bridge-override-conflict'].includes(error.message)) throw error;
      throw new Error('direct-link-failed');
    }
    let directory;
    let child;
    try {
      signal.throwIfAborted();
      directory = await fs.mkdtemp(path.join(localRoot, 'melvor-queue-session-'));
      signal.throwIfAborted();
      child = spawn(stage.executable, [], {
        cwd: stage.directory, stdio: 'ignore', detached: true,
        env: { ...process.env, SteamAppId: '3218350', MELVOR_CALCULATOR_BRIDGE_DIR: directory }
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      if (directory) await removeTemporaryBridgeDirectory(localRoot, directory);
      await stage.cleanup?.();
      throw error;
    }
    child.unref();
    session = { child, directory, executable: stage.executable };
    child.once('exit', () => {
      if (session?.child === child) session = undefined;
      void removeTemporaryBridgeDirectory(localRoot, directory);
      void stage.cleanup?.();
    });
    session.ready = await send('hello', {}, signal, 40000) === 'connected';
    if (!session.ready) throw new Error('bridge-unavailable');
    return session;
  }

  async function send(operation, params, signal, timeout = 12000) {
    const { directory, child } = session;
    const id = randomUUID();
    const request = path.join(directory, 'request.json');
    const response = path.join(directory, 'response.json');
    const pending = request + '.' + id;
    const deadline = Date.now() + timeout;
    signal.throwIfAborted();
    await fs.writeFile(pending, JSON.stringify({ id, operation, ...params }), { flag: 'wx' });
    try {
      signal.throwIfAborted();
      await fs.rename(pending, request);
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        const raw = await fs.readFile(response, 'utf8').catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (raw) {
          const reply = JSON.parse(raw);
          if (reply.id === id) return reply.state;
        }
        await delay(150, undefined, { signal });
      }
      throw new Error('bridge-unavailable');
    } finally {
      await fs.rm(pending, { force: true }).catch(() => {});
      await fs.rm(request, { force: true }).catch(() => {});
    }
  }
  return { connect, send, restart };
}

module.exports = { directQueueSkills, createGameBridge, prepareLinkedGame, hasBridgeAssembly };
