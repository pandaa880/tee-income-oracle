/**
 * Trust anchors compiled into the verifier. Nothing here is fetched: a verifier
 * that downloads its root would trust whoever answers the download.
 */
import { fromHex } from '@tio/encoding';

/**
 * AWS Nitro Enclaves root certificate (G1), DER. Published by AWS at
 * https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip with the
 * SHA-256 below (docs: "Verifying the root CA" in the Nitro attestation guide).
 * The bytes are the `cabundle[0]` of every archived document; the test
 * `pinned.test.ts` asserts `sha256(AWS_NITRO_ROOT_DER) == AWS_NITRO_ROOT_SHA256`,
 * so a swapped root can't pass unnoticed.
 */
export const AWS_NITRO_ROOT_SHA256 =
  '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';
export const AWS_NITRO_ROOT_DER: Uint8Array = fromHex(
  '3082021130820196a003020102021100f93175681b90afe11d46ccb4e4e7f856300a06082a8648ce3d0403033049310b3009060355040613025553310f300d060355040a0c06416d617a6f6e310c300a060355040b0c03415753311b301906035504030c126177732e6e6974726f2d656e636c61766573301e170d3139313032383133323830355a170d3439313032383134323830355a3049310b3009060355040613025553310f300d060355040a0c06416d617a6f6e310c300a060355040b0c03415753311b301906035504030c126177732e6e6974726f2d656e636c617665733076301006072a8648ce3d020106052b8104002203620004fc0254eba608c1f36870e29ada90be46383292736e894bfff672d989444b5051e534a4b1f6dbe3c0bc581a32b7b176070ede12d69a3fea211b66e752cf7dd1dd095f6f1370f4170843d9dc100121e4cf63012809664487c9796284304dc53ff4a3423040300f0603551d130101ff040530030101ff301d0603551d0e041604149025b50dd90547e796c396fa729dcf99a9df4b96300e0603551d0f0101ff040403020186300a06082a8648ce3d0403030369003066023100a37f2f91a1c9bd5ee7b8627c1698d255038e1f0343f95b63a9628c3d39809545a11ebcbf2e3b55d8aeee71b4c3d6adf3023100a2f39b1605b27028a5dd4ba069b5016e65b4fbde8fe0061d6a53197f9cdaf5d943bc61fc2beb03cb6fee8d2302f3dff6',
);

/**
 * PCR0–2 of Marlin Oyster's base image "blue" v3.0.0 for arm64: the kernel,
 * init and boot environment the enclave runs on. They are the same in every
 * attestation of a non-debug enclave on that image, and they are part of the
 * image id (`image-id.ts`). A `--debug` enclave has all-zero PCRs and fails here.
 *
 * Values taken from the archived devnet documents
 * (`deployments/devnet/attestation-{0,1}.hex`), which `oyster-cvm verify` 5.0.1
 * accepted at rotation: that CLI computes the image id from the published PCRs
 * of its base images, so an image id it reproduces vouches for these three values.
 */
export const MARLIN_BLUE_V3_ARM64_PCRS: Readonly<{
  pcr0: Uint8Array;
  pcr1: Uint8Array;
  pcr2: Uint8Array;
}> = {
  pcr0: fromHex(
    '3aa0e6e6ed7d8301655fced7e6ddcc443a3e57bf62f070caa6becf337069e859c0f03d68136440ff1cab8adefd20634c',
  ),
  pcr1: fromHex(
    'b0d319fa64f9c2c9d7e9187bc21001ddacfab4077e737957fa1b8b97cc993bed43a79019aebfd40ee5f6f213147909f8',
  ),
  pcr2: fromHex(
    'fdb2295dc5d9b67a653ed5f3ead5fc8166ec3cae1de1c7c6f31c3b43b2eb26ab5d063f414f3d2b93163426805dfe057e',
  ),
};
