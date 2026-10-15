import * as net from 'node:net';
import { serialize, deserialize } from 'node:v8';
import type { AttachmentProjectionChanges, RuntimeChange, RuntimeCommitResult } from './contracts';

export interface ClientCommitPeer {
  hostBootId: string;
  livenessId: string;
  clientCommitPort?: number;
  retired?: boolean;
}

interface CommitPage {
  cursor: number;
  complete: boolean;
  changes: RuntimeChange[];
  attachmentProjectionChanges: AttachmentProjectionChanges[];
}

/** Process-local notifications, not a durable ledger. A missing/overrun peer requires a snapshot. */
export class ExternalClientCommits {
  private readonly retained: Array<{ cursor: number; body: Buffer }> = [];
  private readonly peers = new Map<string, number>();
  private readonly sockets = new Set<net.Socket>();
  private server?: net.Server;
  private cursor = 0;
  private floor = 0;
  private bytes = 0;
  public port?: number;

  public async start(token: string, barrier: () => Promise<unknown>): Promise<void> {
    const server = net.createServer(socket => {
      socket.on('error', () => socket.destroy());
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      receive(socket).then(async request => {
        const input = request as { token: string; after?: number };
        if (input.token !== token) throw new Error('Retired client commit endpoint.');
        // Commit messages precede this worker barrier, including a transaction already in flight.
        await barrier();
        const complete = input.after === undefined || input.after >= this.floor && input.after <= this.cursor;
        const commits = complete && input.after !== undefined
          ? this.retained.filter(item => item.cursor > input.after!).map(item => deserialize(item.body) as Pick<RuntimeCommitResult, 'changes' | 'attachmentProjectionChanges'>)
          : [];
        send(socket, { cursor: this.cursor, complete, changes: commits.flatMap(commit => commit.changes),
          attachmentProjectionChanges: commits.flatMap(commit => commit.attachmentProjectionChanges ? [commit.attachmentProjectionChanges] : []) } satisfies CommitPage);
      }).catch(() => socket.destroy());
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.on('error', () => this.close());
    server.unref();
    this.port = (server.address() as net.AddressInfo).port;
  }

  public record(commit: RuntimeCommitResult): void {
    const cursor = ++this.cursor;
    if (commit.changes.length === 0 && !commit.attachmentProjectionChanges) return;
    const body = commit.changes.length <= 128
      ? serialize({ changes: commit.changes, attachmentProjectionChanges: commit.attachmentProjectionChanges }) : undefined;
    if (!body || body.length > 512 * 1024) {
      this.floor = cursor;
      this.retained.length = 0;
      this.bytes = 0;
      return;
    }
    this.retained.push({ cursor, body });
    this.bytes += body.length;
    while (this.bytes > 512 * 1024 || this.retained.length > 64) {
      const discarded = this.retained.shift()!;
      this.bytes -= discarded.body.length;
      this.floor = discarded.cursor;
    }
  }

  /** Called before the initial snapshot and only on SQLite external changes thereafter. */
  public async poll(peers: ClientCommitPeer[], baseline = false): Promise<RuntimeChange[] | null> {
    return (await this.pollPage(peers, baseline))?.changes ?? null;
  }

  public async pollAttachmentProjectionChanges(peers: ClientCommitPeer[], baseline = false): Promise<AttachmentProjectionChanges[] | null> {
    return (await this.pollPage(peers, baseline))?.attachmentProjectionChanges ?? null;
  }

  private async pollPage(peers: ClientCommitPeer[], baseline: boolean): Promise<Pick<CommitPage, 'changes' | 'attachmentProjectionChanges'> | null> {
    const key = (peer: ClientCommitPeer) => peer.hostBootId + ':' + peer.livenessId;
    const live = new Set(peers.map(key));
    let complete = true;
    let advanced = false;
    const changes: RuntimeChange[] = [];
    const attachmentProjectionChanges: AttachmentProjectionChanges[] = [];
    for (const id of this.peers.keys()) {
      if (!live.has(id)) { this.peers.delete(id); complete = false; }
    }
    await Promise.all(peers.map(async peer => {
      const id = key(peer);
      const after = this.peers.get(id);
      if (peer.retired || after === -1) {
        if (after !== -1 && !baseline) complete = false;
        this.peers.set(id, -1);
        return;
      }
      if (!peer.clientCommitPort) { this.peers.set(id, -2); complete = false; return; }
      try {
        const page = await query(peer, after);
        this.peers.set(id, page.cursor);
        if (after === undefined && !baseline || !page.complete) complete = false;
        if (after !== undefined && page.cursor > after) advanced = true;
        changes.push(...page.changes);
        attachmentProjectionChanges.push(...page.attachmentProjectionChanges);
      } catch { complete = false; }
    }));
    // A data_version change not explained by registered writers is an ordinary coarse refresh,
    // e.g. offline tooling or a writer whose process exited before its notification was retained.
    return baseline || complete && advanced ? { changes, attachmentProjectionChanges } : null;
  }

  public reset(): void { this.peers.clear(); }

  public close(): void {
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = undefined;
    server?.close();
    this.port = undefined;
    this.retained.length = 0;
    this.bytes = 0;
    this.peers.clear();
  }
}

async function query(peer: ClientCommitPeer, after: number | undefined): Promise<CommitPage> {
  const socket = net.createConnection({ host: '127.0.0.1', port: peer.clientCommitPort! });
  socket.on('error', () => socket.destroy());
  const response = receive(socket);
  socket.once('connect', () => send(socket, { token: peer.livenessId, ...(after === undefined ? {} : { after }) }));
  try { return await response as CommitPage; }
  finally { socket.destroy(); }
}

function send(socket: net.Socket, value: unknown): void {
  const body = serialize(value), header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  socket.write(header);
  socket.write(body);
}

function receive(socket: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const finish = (error?: Error, value?: unknown) => {
      socket.off('data', data); socket.off('error', failed); socket.off('close', closed);
      socket.setTimeout(0);
      if (error) reject(error); else resolve(value);
    };
    const failed = (error: Error) => finish(error);
    const closed = () => finish(new Error('Client commit peer closed.'));
    const data = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE();
      if (length > 1024 * 1024) { finish(new Error('Client commit page exceeded its bound.')); socket.destroy(); return; }
      if (bytes.length < 4 + length) return;
      try { finish(undefined, deserialize(bytes.subarray(4, 4 + length))); }
      catch (error) { finish(error as Error); }
    };
    socket.on('data', data); socket.once('error', failed); socket.once('close', closed);
    socket.setTimeout(250, () => { finish(new Error('Client commit peer is busy.')); socket.destroy(); });
  });
}
