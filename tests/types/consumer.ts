// Smoke test: does the shipped .d.ts actually describe usable API surface?
import VDONinja, {
    VDONinja as NamedVDONinja,
    VDONinjaSDK,
    PeerQuality,
    FileTransferResult,
    DisconnectedDetail
} from '@vdoninja/sdk/browser';

const named = new NamedVDONinja();
const aliased = new VDONinjaSDK();
void named;
void aliased;

async function main() {
    const vdo = new VDONinja({ host: 'wss://apibackup.vdo.ninja', password: false, debug: true });

    await vdo.connect();
    await vdo.joinRoom({ room: 'typed' });
    const id: string = await vdo.announce({ streamID: 'typed_stream' });

    // File transfer
    const offered = vdo.hostFile(new Uint8Array(16), { name: 'a.bin' });
    const size: number = offered.size;
    vdo.on('fileList', async (e) => {
        const first = e.detail.files[0];
        const result: FileTransferResult = await vdo.requestFile(e.detail.uuid, first.id);
        if (result.bytes) { const n: number = result.bytes.byteLength; void n; }
    });

    // Resources
    await vdo.sendResource('peer-uuid', { templateName: 'logo', type: 'image/png' }, new Uint8Array(4));

    // Diagnostics
    const q: PeerQuality | null = await vdo.getPeerQuality('peer-uuid');
    const reports = await vdo.getStats('peer-uuid');
    for (const report of reports['peer-uuid'] || []) {
        const direction: 'publisher' | 'viewer' = report.connectionType;
        void direction;
    }
    if (q && q.rttMs !== null) { const ms: number = q.rttMs; void ms; }

    // Lifecycle
    vdo.on('disconnected', (e) => {
        const d: DisconnectedDetail = e.detail;
        if (d.intentional && d.phase === 'teardown') { /* cleanup finished */ }
    });
    vdo.on('teardownComplete', (e) => { const r: string = e.detail.reason; void r; });
    vdo.on('obsState', (e) => {
        const visible: boolean | null | undefined = e.detail.state.visibility;
        const changed: boolean | null | undefined = e.detail.update.sourceActive;
        void visible; void changed;
    });

    await vdo.disconnect();   // awaitable
    void id; void size;
}
void main;

// Binary transport surface
async function binary() {
    const vdo = new VDONinja();
    const ok: boolean = await vdo.sendBinary(new Uint8Array(8), 'peer');
    const ch: RTCDataChannel = await vdo.openChannel('peer', 'bulk', {
        ordered: false,
        maxRetransmits: 0,
        timeout: 5000
    });
    const found: RTCDataChannel | null = vdo.getChannel('peer', 'bulk');
    const buf: number | null = vdo.getBufferedAmount('peer', 'bulk');
    const max: number | null = vdo.getMaxMessageSize('peer');
    vdo.on('binaryReceived', (e) => { if (e.detail.bytes) { const n: number = e.detail.bytes.byteLength; void n; } });
    vdo.on('bufferedAmountLow', (e) => { const l: string = e.detail.label; void l; });
    vdo.on('channelOpen', (e) => { const c: RTCDataChannel = e.detail.channel; void c; });
    void ok; void ch; void found; void buf; void max;
}
void binary;
