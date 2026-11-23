/**
 * Issue #339 isolated headless RPC smoke test for Pi MCP Extension.
 * Run from the fix branch checkout after npm ci with Node 24:
 *   node /tmp/pi-mcp-339-rpc-smoke.mjs 2>&1 | tee /tmp/pi-mcp-339-rpc-output.txt
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), 'pi-339-'));
const pi = resolve('node_modules/.bin/pi');
const entry = resolve('src/index.ts');
let child;

async function run(disabled) {
  const name = disabled ? 'disabled' : 'enabled';
  const home = join(dir, name);
  await mkdir(home);
  const marker = join(home, 'spawned.txt');
  const serverUrl = pathToFileURL(resolve('tests/mock-server.ts')).href;
  const code = [
    'const fs = require("node:fs");',
    `fs.appendFileSync(${JSON.stringify(marker)}, process.pid + "\\n");`,
    `import(${JSON.stringify(serverUrl)}).catch(e => { console.error(e); process.exitCode = 1; });`
  ].join(' ');
  await writeFile(join(home, 'mcp.json'), JSON.stringify({
    mcpServers: {mock: {
      type: 'stdio', command: process.execPath,
      args: ['--import', 'tsx/esm', '-e', code],
      cwd: root, lifecycle: 'eager'
    }}
  }));
  const args = ['--mode', 'rpc', '--no-session', '-e', entry, ...(disabled ? ['--no-mcp'] : [])];
  console.log('Command: ./node_modules/.bin/pi ' + args.map(x => x === entry ? './src/index.ts' : x).join(' '));
  child = spawn(pi, args, {
    cwd: root, env: {...process.env, PI_CODING_AGENT_DIR: home, PI_MCP_DEBUG: '0'},
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '', stderr = '', records = [], waiters = [], id = 0;
  child.stdout.on('data', b => {
    buffer += b;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch { continue; }
      records.push(record);
      for (const w of [...waiters]) {
        if (records.length - 1 < w.from || !w.test(record)) continue;
        clearTimeout(w.timer);
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(record);
      }
    }
  });
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-1500); });
  function wait(label, test, from = 0) {
    const found = records.find((r, i) => i >= from && test(r));
    if (found) return Promise.resolve(found);
    return new Promise((resolveWait, reject) => {
      const waiter = {from, test, resolve: resolveWait,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(Error(`${label} timed out; stderr: ${stderr}`));
        }, 45000)
      };
      waiters.push(waiter);
    });
  }
  async function send(type, fields = {}) {
    const from = records.length, req = String(++id);
    child.stdin.write(JSON.stringify({id: req, type, ...fields}) + '\n');
    const response = await wait(type, r => r.type === 'response' && r.id === req, from);
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  }
  async function prompt(message, pattern) {
    const from = records.length;
    const response = send('prompt', {message});
    const record = await wait(message, r => r.method === 'notify' && pattern.test(String(r.message)), from);
    await response;
    return record;
  }
  try {
    const result = await send('get_commands');
    const commands = (result.data?.commands || []).map(c => c.name)
      .filter(n => n === 'mcp' || n.startsWith('mcp:'));
    if (disabled) {
      assert.deepEqual(commands, []);
      console.log('PASS --no-mcp: zero MCP commands');
    } else {
      assert.deepEqual(commands.sort(), ['mcp','mcp:auth','mcp:resources','mcp:start','mcp:stop']);
      console.log('PASS normal: all five MCP commands registered');
      await prompt('/mcp', /MCP: 1\/1 servers ready/);
      console.log('PASS normal: MCP mock server ready');
      await prompt('/mcp mock', /Server: mock[\s\S]*State:\s+ready/);
      console.log('PASS normal: server detail ready');
      await prompt('/mcp:stop mock', /Stopped mock/);
      await prompt('/mcp:start mock', /Started mock/);
      console.log('PASS normal: stop and restart');
      const next = await send('new_session');
      assert.equal(next.data?.cancelled, false);
      await prompt('/mcp', /MCP: 1\/1 servers ready/);
      console.log('PASS normal: new_session reload');
    }
    child.stdin.end();
    const exit = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(Error('Pi did not exit within 20 seconds')), 20000);
      child.once('exit', code => { clearTimeout(timer); res(code); });
      child.once('error', err => { clearTimeout(timer); rej(err); });
    });
    assert.equal(exit, 0, `Pi exited ${exit}; stderr: ${stderr}`);
    const data = await readFile(marker, 'utf8').catch(e => e.code === 'ENOENT' ? '' : Promise.reject(e));
    const pids = data.trim() ? data.trim().split(/\s+/).map(Number) : [];
    if (disabled) {
      assert.equal(pids.length, 0);
      console.log('PASS --no-mcp: spawns=0');
    } else {
      assert.ok(pids.length > 0, 'Expected eager server spawn');
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
      console.log('PASS normal: child processes cleaned up');
    }
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    child = null;
  }
}

try {
  await run(false);
  await run(true);
  console.log('RESULT: PASS — normal MCP lifecycle works and --no-mcp skips startup');
} catch (error) {
  console.error('RESULT: FAIL — ' + (error.stack ?? String(error)));
  process.exitCode = 1;
} finally {
  await rm(dir, {recursive: true, force: true});
}
