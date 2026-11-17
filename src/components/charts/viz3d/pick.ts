/**
 * Picking under the pointer, shared by the Grow tower and the 3D charts: a
 * ray from the camera through the pointer's spot on the canvas, and how far
 * a press may move before it's a drag rather than a click.
 */
import * as THREE from 'three'

/** A press that moves this many pixels or fewer (across and down together) is a click; more turns the view. */
export const TAP_SLOP = 3

const pointer = new THREE.Vector2()

/** The nearest of `objects` under the pointer, if any. */
export function pointerHit(ray: THREE.Raycaster, camera: THREE.Camera, canvas: HTMLElement, e: { clientX: number, clientY: number }, objects: THREE.Object3D[]): THREE.Object3D | undefined {
  const r = canvas.getBoundingClientRect()
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  ray.setFromCamera(pointer, camera)
  return ray.intersectObjects(objects, false)[0]?.object
}
