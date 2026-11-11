// npm test 的前置：把 ~/.huashu-chrome 换成一次性的临时目录。
//
// 测试起的桥、MCP 子进程都会写审计、写 bridge.log、读 bridge.json——不隔离的话，
// 测试命令（"old-one"、"profile-a"……）会混进用户真实的 audit.jsonl，
// 而审计正是「出事能查」的唯一凭据。子进程继承环境变量，一并隔离。
// test:live 不走这里：它要连的就是真桥。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.HUASHU_CHROME_HOME) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huashu-chrome-test-'));
  process.env.HUASHU_CHROME_HOME = dir;
  // 谁建的谁删：继承了变量的子进程不会走到这里
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉就留着 */ } });
}
