// Integration test against a running worker.
// Usage: node test/rooms.test.mjs [baseUrl]   (default http://127.0.0.1:8787)
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const ORIGIN = 'http://localhost:5190';
const PROTOCOL = 2;
const ROOM = `T${randomBytes(3).toString('hex').toUpperCase()}`;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

class Client {
  constructor(name, token = randomBytes(12).toString('hex'), origin = ORIGIN) {
    this.name = name;
    this.token = token;
    this.inbox = [];
    this.waiters = [];
    this.closed = null;
    this.ws = new WebSocket(`${WS_BASE}/room/${ROOM.toLowerCase()}`, { headers: { Origin: origin } });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      this.inbox.push(msg);
      this.flush();
    });
    this.ws.on('close', (code) => {
      this.closed = code;
      this.flush();
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }
  flush() {
    for (const w of [...this.waiters]) {
      const i = this.inbox.findIndex(w.pred);
      if (i >= 0) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(this.inbox.splice(i, 1)[0]);
      }
    }
  }
  next(pred, ms = 3000) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          resolve(null);
        }
      }, ms);
    });
  }
  type(t, ms) {
    return this.next((m) => m.t === t, ms);
  }
  send(msg) {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  async hello(look = 1) {
    await this.opened;
    this.send({ t: 'hello', v: PROTOCOL, token: this.token, name: this.name, look });
    return this.type('welcome');
  }
  drain() {
    this.inbox.length = 0;
  }
  close() {
    this.ws.close();
  }
}

const balls = () => Array.from({ length: 16 }, (_, i) => [i * 0.1, -i * 0.1, 1]);
const snapshot = (shotSeq, current = 0, over = null) => ({
  match: { current, groups: [null, null], isBreak: shotSeq === 0, ballInHand: false, kitchenOnly: false, winner: null },
  balls: balls(),
  assisted: true,
  shotSeq,
  over,
});
const shot = (seq) => ({ seq, before: balls(), dirX: 1, dirZ: 0, speed: 3, side: 0, vertical: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Target ${BASE}, room ${ROOM}`);

  const health = await fetch(`${BASE}/health`);
  check('GET /health -> 200 ok', health.status === 200 && (await health.text()) === 'ok');
  check('GET /nope -> 404', (await fetch(`${BASE}/nope`)).status === 404);

  const forbidden = new Client('Evil', undefined, 'https://evil.example');
  const forbiddenErr = await forbidden.opened.then(() => 'opened', (e) => e.message);
  check('disallowed origin -> 403', forbiddenErr === 'HTTP 403', forbiddenErr);

  const noOrigin = await fetch(`${BASE}/room/${ROOM}`);
  check('missing origin -> 403', noOrigin.status === 403, noOrigin.status);

  const badCode = await fetch(`${BASE}/room/AB`, { headers: { Origin: ORIGIN } });
  check('plain GET with allowed origin -> 426', badCode.status === 426, badCode.status);
  const badCodeWs = new WebSocket(`${WS_BASE}/room/A!B`, { headers: { Origin: ORIGIN } });
  const badCodeStatus = await new Promise((r) => {
    badCodeWs.once('unexpected-response', (_q, res) => r(res.statusCode));
    badCodeWs.once('open', () => r('open'));
    badCodeWs.once('error', () => {});
  });
  check('invalid room code -> 400', badCodeStatus === 400, badCodeStatus);

  const a = new Client('  Alice\u0007​  ');
  const wa = await a.hello(2);
  check('A welcome', wa?.t === 'welcome' && typeof wa.you === 'string' && wa.snapshot === null, wa);
  const meA = wa?.players.find((p) => p.id === wa.you);
  check('A seat 0, host, sanitized name', meA?.seat === 0 && meA.host && meA.name === 'Alice', meA);

  const b = new Client('Bob');
  const wb = await b.hello(3);
  check('B welcome', wb?.t === 'welcome' && wb.players.length === 2, wb);
  const meB = wb?.players.find((p) => p.id === wb.you);
  check('B seat 1, not host', meB?.seat === 1 && !meB.host, meB);
  const pa = await a.next((m) => m.t === 'players' && m.players.length === 2);
  check('A receives players with B', !!pa, pa);

  a.drain();
  b.drain();
  const pose = { x: 1.5, z: -2, yaw: 0.3, action: 'drink', speed: 1.2, atTable: false };
  a.send({ t: 'pose', pose });
  const gotPose = await b.type('pose');
  check('pose relayed to B with id', gotPose?.id === wa.you && gotPose.pose.action === 'drink', gotPose);
  check('pose not echoed to A', (await a.type('pose', 400)) === null);

  const aim = { dirX: 1, dirZ: 0, power: 0.4, side: 0, vertical: 0, cueX: 0.2, cueZ: 0.1, pocket: 3 };
  a.send({ t: 'aim', aim });
  check('aim with called pocket relayed', (await b.type('aim'))?.aim.pocket === 3);
  a.send({ t: 'aim', aim: { ...aim, pocket: 6 } });
  check('aim with pocket out of range -> bad', (await a.type('error'))?.code === 'bad');
  a.send({ t: 'aim', aim: { ...aim, pocket: undefined } });
  check('aim without pocket -> bad', (await a.type('error'))?.code === 'bad');

  a.send({ t: 'chat', text: '  hola   vaquero ​ ' });
  const gotChat = await b.type('chat');
  check('chat relayed sanitized with id', gotChat?.id === wa.you && gotChat.text === 'hola vaquero', gotChat);
  check('chat not echoed to A', (await a.type('chat', 400)) === null);
  a.send({ t: 'chat', text: 'x'.repeat(500) });
  check('long chat clipped to 120', (await b.type('chat'))?.text.length === 120);
  a.send({ t: 'chat', text: '  ' });
  check('empty chat -> bad', (await a.type('error'))?.code === 'bad');
  a.send({ t: 'chat', text: 42 });
  check('non-string chat -> bad', (await a.type('error'))?.code === 'bad');
  await sleep(5_100);
  b.drain();
  for (let i = 0; i < 12; i++) a.send({ t: 'chat', text: `spam ${i}` });
  await sleep(600);
  const chats = b.inbox.filter((m) => m.t === 'chat').length;
  check(`chat rate limit (${chats} of 12)`, chats === 5, chats);
  b.drain();

  a.send({ t: 'pose', pose: { ...pose, x: null } });
  check('invalid pose -> bad', (await a.type('error'))?.code === 'bad');
  a.send('not json');
  check('invalid JSON -> bad', (await a.type('error'))?.code === 'bad');
  a.send({ t: 'wat' });
  check('unknown type -> bad', (await a.type('error'))?.code === 'bad');
  a.send({ t: 'face', data: 'x'.repeat(90_000) });
  check('oversized message -> bad', (await a.type('error'))?.code === 'bad');
  a.send({ t: 'ping' });
  check('ping -> pong', !!(await a.type('pong')));
  a.send({ t: 'ping', extra: 1 });
  check('ping (non-canonical) -> pong', !!(await a.type('pong')));

  a.send({ t: 'face', data: 'data:image/png;base64,AAAA' });
  check('face png -> bad', (await a.type('error'))?.code === 'bad');
  const face = `data:image/jpeg;base64,${randomBytes(300).toString('base64')}`;
  a.send({ t: 'face', data: face });
  const gotFace = await b.type('face');
  check('face relayed to B', gotFace?.id === wa.you && gotFace.data === face);
  const facePlayers = await b.next((m) => m.t === 'players' && m.players.some((p) => p.id === wa.you && p.hasFace));
  check('players shows hasFace', !!facePlayers);

  b.send({ t: 'start', snapshot: snapshot(0) });
  check('start by non-host -> forbidden', (await b.type('error'))?.code === 'forbidden');

  a.send({ t: 'start', snapshot: { ...snapshot(0), balls: balls().slice(1) } });
  check('start with 15 balls -> bad', (await a.type('error'))?.code === 'bad');

  a.send({ t: 'start', snapshot: snapshot(0) });
  const [sa, sb] = await Promise.all([a.type('start'), b.type('start')]);
  check('start reaches A and B', sa?.snapshot.shotSeq === 0 && sb?.snapshot.shotSeq === 0, { sa, sb });

  b.send({ t: 'shot', shot: shot(1) });
  check('shot out of turn -> forbidden', (await b.type('error'))?.code === 'forbidden');
  a.send({ t: 'shot', shot: shot(5) });
  check('shot wrong seq -> forbidden', (await a.type('error'))?.code === 'forbidden');

  a.send({ t: 'shot', shot: shot(1) });
  const gotShot = await b.type('shot');
  check('shot relayed to B', gotShot?.id === wa.you && gotShot.shot.seq === 1, gotShot);

  b.send({ t: 'result', result: { seq: 1, snapshot: snapshot(1, 1), messages: [] } });
  check('result from non-shooter -> forbidden', (await b.type('error'))?.code === 'forbidden');

  a.send({ t: 'result', result: { seq: 1, snapshot: snapshot(1, 1), messages: [{ text: 'Falta', kind: 'foul' }] } });
  const gotResult = await b.type('result');
  check('result relayed to B', gotResult?.result.seq === 1 && gotResult.result.snapshot.match.current === 1, gotResult);

  a.send({ t: 'shot', shot: shot(2) });
  check('A shot after turn change -> forbidden', (await a.type('error'))?.code === 'forbidden');
  b.send({ t: 'shot', shot: shot(2) });
  check('B shot seq 2 relayed', (await a.type('shot'))?.shot.seq === 2);

  // Reconnect B with same token: must keep seat and id, old socket closed.
  a.drain();
  const b2 = new Client('Bob2', b.token);
  const wb2 = await b2.hello(4);
  const meB2 = wb2?.players.find((p) => p.id === wb2.you);
  check('reconnect keeps id and seat', wb2?.you === wb.you && meB2?.seat === 1 && meB2.name === 'Bob2', meB2);
  check('reconnect welcome has snapshot', wb2?.snapshot?.shotSeq === 1, wb2?.snapshot);
  const faceOnJoin = await b2.type('face');
  check('reconnect receives stored face', faceOnJoin?.id === wa.you && faceOnJoin.data === face);
  await sleep(300);
  check('old socket closed with 4000', b.closed === 4000, b.closed);
  b2.send({ t: 'result', result: { seq: 2, snapshot: snapshot(2, 0), messages: [] } });
  check('reconnected shooter can deliver result', (await a.type('result'))?.result.seq === 2);

  // Disconnect keeps the seat during a match.
  b2.close();
  const afterLeave = await a.next((m) => m.t === 'players' && m.players.some((p) => p.id === wb.you && !p.connected));
  check('disconnected player keeps seat, connected=false', afterLeave?.players.find((p) => p.id === wb.you)?.seat === 1, afterLeave);

  const c = new Client('Carol');
  const wc = await c.hello();
  check('new player takes seat 2, not 1', wc?.players.find((p) => p.id === wc.you)?.seat === 2);

  c.send({ t: 'hello', v: PROTOCOL, token: c.token, name: 'x', look: 0 });
  check('second hello -> bad', (await c.type('error'))?.code === 'bad');

  const v = new Client('Old');
  await v.opened;
  v.send({ t: 'hello', v: 99, token: randomBytes(12).toString('hex'), name: 'Old', look: 0 });
  check('wrong version -> error version', (await v.type('error'))?.code === 'version');
  await sleep(200);
  check('wrong version closes socket', v.closed !== null, v.closed);

  const nh = new Client('NoHello');
  await nh.opened;
  nh.send({ t: 'ping', x: 1 });
  check('non-hello first message -> bad + close', (await nh.type('error'))?.code === 'bad');

  a.drain();
  for (let i = 0; i < 150; i++) a.send({ t: 'ping', n: i });
  await sleep(800);
  const pongs = a.inbox.filter((m) => m.t === 'pong').length;
  check(`rate limit caps burst (${pongs} pongs of 150)`, pongs <= 62 && pongs >= 50, pongs);

  for (const cl of [a, c, v, nh]) cl.close();
  await sleep(200);
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
