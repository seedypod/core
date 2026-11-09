/**
 * A tower camera as a HomeKit camera that shows snapshots only (ADR 0027).
 *
 * A snapshot is the newest stored still, the hourly capture, so the Home app
 * never wakes the camera. Only when the camera has no still yet does it take
 * one, at most once per `CAPTURE_FLOOR_MS`. Live view is refused: the unit
 * can't transcode the camera's MJPEG to H.264 (ADR 0027 has the measurements).
 */
import type { CameraStreamingDelegate, HAPStatus } from 'hap-nodejs'
import type { AccessoryDeps, BuiltAccessory, Camera } from './common'

// hap-nodejs declares these as `const enum`s, which isolatedModules can't read.
const H264_PROFILES = [0, 1, 2] // baseline, main, high
const H264_LEVELS = [0, 1, 2] // 3.1, 3.2, 4.0
const SRTP_AES_CM_128_HMAC_SHA1_80 = 0
const AAC_ELD = 'AAC-eld'
const KHZ_16 = 16
export const RESOURCE_DOES_NOT_EXIST = -70409 as HAPStatus

/** How soon a camera with no still may be asked for one again. Home asks every ~10 s while it is open. */
export const CAPTURE_FLOOR_MS = 10 * 60_000

/**
 * What the camera says it could stream. Nothing is streamed (live view is
 * refused), so this is a declaration, not a cost: it matches what working
 * HomeKit cameras declare (HAP's 16:9 and 4:3 sizes at 30 fps, as
 * homebridge-camera-ffmpeg does) so Home accepts the accessory as a camera. A
 * snapshot is the stored still as is, whatever size Home asks for.
 */
export const RESOLUTIONS: Array<[number, number, number]> = [
  [320, 180, 30], [320, 240, 15], [320, 240, 30], [480, 270, 30], [480, 360, 30], [640, 360, 30],
  [640, 480, 30], [1280, 720, 30], [1280, 960, 30], [1920, 1080, 30], [1600, 1200, 30],
]

export const LIVE_VIEW_OFF = 'live view is off: this unit serves snapshots only (ADR 0027)'

/** Answers HomeKit's snapshot requests from storage and turns down live view. */
export function snapshotDelegate(camera: Camera, d: Pick<AccessoryDeps, 'api' | 'stills' | 'log'>, now: () => number = Date.now): CameraStreamingDelegate {
  let lastTry = Number.NEGATIVE_INFINITY
  let inFlight: Promise<unknown> | null = null

  const stored = async (): Promise<Buffer | null> => {
    const got = await d.stills.latest(camera)
    return got ? Buffer.from(got.bytes.buffer, got.bytes.byteOffset, got.bytes.byteLength) : null
  }

  const snapshot = async (): Promise<Buffer> => {
    const still = await stored()
    if (still) return still
    if (!inFlight && now() - lastTry >= CAPTURE_FLOOR_MS) {
      lastTry = now()
      inFlight = d.api.camera.capture({ camera }).finally(() => {
        inFlight = null
      })
    }
    // A failed capture is already an alert in the app; HomeKit just shows no image.
    await inFlight?.catch(() => undefined)
    const fresh = await stored()
    if (!fresh) throw RESOURCE_DOES_NOT_EXIST
    return fresh
  }

  // The first request, and every change of outcome, so the journal shows what Home is getting.
  let logged: string | null = null
  const note = (outcome: string, line: string) => {
    if (outcome !== logged) d.log(`homekit: ${camera} camera: ${line}`)
    logged = outcome
  }
  return {
    handleSnapshotRequest(request, callback) {
      const started = now()
      const size = `${request.width}x${request.height}`
      snapshot().then((b) => {
        note('served', `snapshot ${size} served ${b.byteLength} bytes in ${now() - started} ms`)
        callback(undefined, b)
      }, (e: unknown) => {
        if (e === RESOURCE_DOES_NOT_EXIST) note('none', `snapshot ${size} found no stored still (${now() - started} ms)`)
        else note(`failed: ${(e as Error).message}`, `snapshot ${size} failed: ${(e as Error).message} (${now() - started} ms)`)
        callback(RESOURCE_DOES_NOT_EXIST)
      })
    },
    prepareStream(_request, callback) {
      callback(new Error(LIVE_VIEW_OFF))
    },
    handleStreamRequest(_request, callback) {
      callback(new Error(LIVE_VIEW_OFF))
    },
  }
}

export function buildCamera(camera: Camera, d: AccessoryDeps): BuiltAccessory {
  const controller = new d.hap.CameraController({
    // HAP's minimum for a camera that isn't Secure Video.
    cameraStreamCount: 2,
    delegate: snapshotDelegate(camera, d),
    streamingOptions: {
      supportedCryptoSuites: [SRTP_AES_CM_128_HMAC_SHA1_80],
      video: { codec: { profiles: H264_PROFILES, levels: H264_LEVELS }, resolutions: RESOLUTIONS },
      // Declaring audio is what makes hap-nodejs add the Microphone service HAP lists as required for a camera.
      audio: { codecs: [{ type: AAC_ELD, samplerate: KHZ_16 }] },
    },
  })
  return { services: [], controllers: [controller], stop: () => undefined }
}
