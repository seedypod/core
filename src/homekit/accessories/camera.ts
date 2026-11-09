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
const H264_BASELINE = 0
const H264_LEVEL_3_1 = 0
const SRTP_AES_CM_128_HMAC_SHA1_80 = 0
export const RESOURCE_DOES_NOT_EXIST = -70409 as HAPStatus

/** How soon a camera with no still may be asked for one again. Home asks every ~10 s while it is open. */
export const CAPTURE_FLOOR_MS = 10 * 60_000

/** HomeKit picks a size from these; it gets the stored still as is and scales it. */
const RESOLUTIONS: Array<[number, number, number]> = [[1280, 960, 15], [1280, 720, 15], [640, 480, 15], [640, 360, 15], [320, 240, 15]]

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

  return {
    handleSnapshotRequest(_request, callback) {
      snapshot().then(b => callback(undefined, b), (e: unknown) => {
        if (e !== RESOURCE_DOES_NOT_EXIST) d.log(`homekit: ${camera} snapshot failed: ${(e as Error).message}`)
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
    cameraStreamCount: 1,
    delegate: snapshotDelegate(camera, d),
    streamingOptions: {
      supportedCryptoSuites: [SRTP_AES_CM_128_HMAC_SHA1_80],
      video: { codec: { profiles: [H264_BASELINE], levels: [H264_LEVEL_3_1] }, resolutions: RESOLUTIONS },
    },
  })
  return { services: [], controllers: [controller], stop: () => undefined }
}
