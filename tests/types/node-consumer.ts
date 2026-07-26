import VDONinjaNode, {
    VDONinja,
    VDONinjaSDK,
    WebRTCInfo,
    WebRTCSupport
} from '@vdoninja/sdk/node';
import VDONinjaRoot from '@vdoninja/sdk';

const sdk = new VDONinjaNode();
const rootSdk = new VDONinjaRoot();
const named: VDONinjaNode = new VDONinja();
const aliased: VDONinjaNode = new VDONinjaSDK();

const info: WebRTCInfo = sdk.getWebRTCInfo();
const rootInfo: WebRTCInfo = rootSdk.getWebRTCInfo();
const implementation: string = info.implementation;
const media: boolean = info.hasMediaSupport;

const support: WebRTCSupport[] = VDONinjaNode.checkWebRTCSupport();
if (support.length) {
    const available: boolean = support[0].available;
    void available;
}

void named;
void aliased;
void rootInfo;
void implementation;
void media;
