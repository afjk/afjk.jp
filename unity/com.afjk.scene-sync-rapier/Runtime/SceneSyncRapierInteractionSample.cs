using System.Collections.Generic;
using Afjk.SceneSync;
using UnityEngine;

namespace Afjk.SceneSync.Rapier
{
    [DisallowMultipleComponent]
    public sealed class SceneSyncRapierInteractionSample : MonoBehaviour
    {
        [SerializeField] private SceneSyncRapierBridge bridge;
        [SerializeField] private Camera targetCamera;
        [SerializeField] private LayerMask pickLayers = ~0;
        [SerializeField] private float pickMaxDistance = 200f;
        [SerializeField] private float moveSpeed = 6f;
        [SerializeField] private float fastMoveMultiplier = 3f;
        [SerializeField] private float lookSensitivity = 0.15f;
        [SerializeField] private float inputIntervalSeconds = 0.05f;
        [SerializeField] private int inputLeadTicks = 8;
        [SerializeField] private float throwVelocityScale = 1.2f;
        [SerializeField] private float maxThrowSpeed = 18f;
        [SerializeField] private bool autoAddPickColliders = true;
        [SerializeField] private float pickColliderRefreshInterval = 1f;
        [SerializeField] private bool disableRemoteSnapshotCorrection = true;

        private string draggingObjectId;
        private string draggingInteractionId;
        private Quaternion draggingRotation = Quaternion.identity;
        private Vector3 dragGrabOffset;
        private Vector3 previousDragTarget;
        private Vector3 dragVelocity;
        private float previousDragTargetTime;
        private int dragSequence;
        private int dragTimelineRevision;
        private int dragBranchTick;
        private int lastDragApplyTick = -1;
        private float nextInputPublishAt;
        private float nextColliderRefreshAt;
        private bool hasDragTarget;
        private bool looking;
        private Vector3 previousLookMousePosition;
        private float yaw;
        private float pitch;
        private SceneSyncRapierBridge snapshotOverrideBridge;
        private static readonly Dictionary<SceneSyncRapierBridge, SnapshotCorrectionOverrideState> SnapshotOverrides =
            new Dictionary<SceneSyncRapierBridge, SnapshotCorrectionOverrideState>();

        private bool IsDragging => !string.IsNullOrWhiteSpace(draggingObjectId);

        private void Awake()
        {
            ResolveReferences();
            InitializeLookAngles();
        }

        private void OnEnable()
        {
            ResolveReferences();
            InitializeLookAngles();
        }

        private void OnDisable()
        {
            RestoreSnapshotCorrectionOverride();
            StopLooking();
            ClearDrag();
        }

        private void Update()
        {
            ResolveReferences();
            RefreshPickCollidersIfNeeded();
            UpdateCameraMovement();
            UpdateCameraLook();
            UpdateDragInput();
        }

        private void ResolveReferences()
        {
            if (bridge == null)
                bridge = FindFirstObjectByType<SceneSyncRapierBridge>();

            if (targetCamera == null)
                targetCamera = Camera.main != null ? Camera.main : FindFirstObjectByType<Camera>();

            UpdateSnapshotCorrectionOverride();
        }

        private void InitializeLookAngles()
        {
            if (targetCamera == null) return;
            var euler = targetCamera.transform.eulerAngles;
            yaw = euler.y;
            pitch = NormalizeAngle(euler.x);
        }

        private void UpdateCameraMovement()
        {
            if (targetCamera == null) return;

            var input = Vector3.zero;
            if (Input.GetKey(KeyCode.W)) input += Vector3.forward;
            if (Input.GetKey(KeyCode.S)) input += Vector3.back;
            if (Input.GetKey(KeyCode.D)) input += Vector3.right;
            if (Input.GetKey(KeyCode.A)) input += Vector3.left;
            if (Input.GetKey(KeyCode.E)) input += Vector3.up;
            if (Input.GetKey(KeyCode.Q)) input += Vector3.down;
            if (input.sqrMagnitude <= 0f) return;

            input = Vector3.ClampMagnitude(input, 1f);
            var cameraTransform = targetCamera.transform;
            var worldMove =
                cameraTransform.forward * input.z +
                cameraTransform.right * input.x +
                Vector3.up * input.y;
            var speed = moveSpeed * (Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift)
                ? fastMoveMultiplier
                : 1f);
            cameraTransform.position += worldMove * (speed * Time.unscaledDeltaTime);
        }

        private void UpdateCameraLook()
        {
            if (targetCamera == null) return;

            if (Input.GetMouseButtonDown(1))
            {
                looking = true;
                previousLookMousePosition = Input.mousePosition;
                Cursor.visible = false;
                Cursor.lockState = CursorLockMode.Confined;
            }

            if (!looking) return;

            if (!Input.GetMouseButton(1))
            {
                StopLooking();
                return;
            }

            var current = Input.mousePosition;
            var delta = current - previousLookMousePosition;
            previousLookMousePosition = current;
            yaw += delta.x * lookSensitivity;
            pitch = Mathf.Clamp(pitch - delta.y * lookSensitivity, -88f, 88f);
            targetCamera.transform.rotation = Quaternion.Euler(pitch, yaw, 0f);
        }

        private void StopLooking()
        {
            looking = false;
            Cursor.visible = true;
            Cursor.lockState = CursorLockMode.None;
        }

        private void UpdateDragInput()
        {
            if (bridge == null || targetCamera == null || !bridge.HasWorld)
            {
                ClearDrag();
                return;
            }

            if (Input.GetMouseButtonDown(0) && !Input.GetMouseButton(1))
                BeginDrag();

            if (!IsDragging) return;

            if (!Input.GetMouseButton(0))
            {
                ReleaseDrag();
                return;
            }

            if (TryGetDragTarget(out var targetPosition))
            {
                UpdateDragVelocity(targetPosition);
                if (Time.unscaledTime >= nextInputPublishAt)
                    PublishDragState(targetPosition, dragVelocity, "grab-move");
            }
        }

        private void BeginDrag()
        {
            if (!TryPickDynamicObject(out var identity, out var hitPoint))
                return;

            if (!bridge.TryGetDynamicBodyState(
                    identity.ObjectId,
                    out var position,
                    out var rotation,
                    out var linearVelocity,
                    out _))
            {
                return;
            }

            draggingObjectId = identity.ObjectId;
            draggingInteractionId = System.Guid.NewGuid().ToString("N");
            draggingRotation = rotation;
            dragGrabOffset = position - hitPoint;
            previousDragTarget = position;
            dragVelocity = linearVelocity;
            previousDragTargetTime = Time.unscaledTime;
            dragSequence = 0;
            dragBranchTick = bridge.Tick;
            dragTimelineRevision = bridge.PreparePhysicsTimelineBranch(dragBranchTick);
            lastDragApplyTick = -1;
            hasDragTarget = true;
            PublishDragState(position, linearVelocity, "grab-start");
            nextInputPublishAt = Time.unscaledTime + Mathf.Max(0.005f, inputIntervalSeconds);
        }

        private void ReleaseDrag()
        {
            if (!IsDragging)
            {
                ClearDrag();
                return;
            }

            if (TryGetDragTarget(out var targetPosition))
                UpdateDragVelocity(targetPosition);

            var throwVelocity = Vector3.ClampMagnitude(dragVelocity * Mathf.Max(0f, throwVelocityScale), maxThrowSpeed);
            PublishDragState(previousDragTarget, throwVelocity, "grab-release");
            ClearDrag();
        }

        private void ClearDrag()
        {
            draggingObjectId = null;
            draggingInteractionId = null;
            draggingRotation = Quaternion.identity;
            dragGrabOffset = Vector3.zero;
            previousDragTarget = Vector3.zero;
            dragVelocity = Vector3.zero;
            previousDragTargetTime = 0f;
            dragSequence = 0;
            dragTimelineRevision = 0;
            dragBranchTick = 0;
            lastDragApplyTick = -1;
            nextInputPublishAt = 0f;
            hasDragTarget = false;
        }

        private void UpdateSnapshotCorrectionOverride()
        {
            if (!isActiveAndEnabled || !disableRemoteSnapshotCorrection || bridge == null)
            {
                RestoreSnapshotCorrectionOverride();
                return;
            }

            if (snapshotOverrideBridge == bridge)
                return;

            RestoreSnapshotCorrectionOverride();
            snapshotOverrideBridge = bridge;
            if (SnapshotOverrides.TryGetValue(bridge, out var state))
            {
                state.ReferenceCount++;
                SnapshotOverrides[bridge] = state;
                return;
            }

            SnapshotOverrides[bridge] = new SnapshotCorrectionOverrideState(
                bridge.AutoApplyRemoteSnapshots,
                bridge.RequestSnapshotOnHashMismatch);
            bridge.AutoApplyRemoteSnapshots = false;
            bridge.RequestSnapshotOnHashMismatch = false;
        }

        private void RestoreSnapshotCorrectionOverride()
        {
            if (snapshotOverrideBridge == null)
                return;

            if (SnapshotOverrides.TryGetValue(snapshotOverrideBridge, out var state))
            {
                state.ReferenceCount--;
                if (state.ReferenceCount <= 0)
                {
                    if (!snapshotOverrideBridge.AutoApplyRemoteSnapshots)
                        snapshotOverrideBridge.AutoApplyRemoteSnapshots = state.AutoApplyRemoteSnapshots;
                    if (!snapshotOverrideBridge.RequestSnapshotOnHashMismatch)
                        snapshotOverrideBridge.RequestSnapshotOnHashMismatch = state.RequestSnapshotOnHashMismatch;
                    SnapshotOverrides.Remove(snapshotOverrideBridge);
                }
                else
                {
                    SnapshotOverrides[snapshotOverrideBridge] = state;
                }
            }

            snapshotOverrideBridge = null;
        }

        private bool TryPickDynamicObject(out SceneSyncIdentity identity, out Vector3 hitPoint)
        {
            identity = null;
            hitPoint = Vector3.zero;

            var ray = targetCamera.ScreenPointToRay(Input.mousePosition);
            if (!Physics.Raycast(ray, out var hit, Mathf.Max(0.01f, pickMaxDistance), pickLayers, QueryTriggerInteraction.Ignore))
                return false;

            identity = hit.collider.GetComponentInParent<SceneSyncIdentity>();
            if (identity == null ||
                string.IsNullOrWhiteSpace(identity.ObjectId) ||
                !bridge.HasDynamicBody(identity.ObjectId))
            {
                identity = null;
                return false;
            }

            hitPoint = hit.point;
            return true;
        }

        private bool TryGetDragTarget(out Vector3 targetPosition)
        {
            targetPosition = previousDragTarget;
            if (!IsDragging || targetCamera == null)
                return false;

            var ray = targetCamera.ScreenPointToRay(Input.mousePosition);
            var planeNormal = -targetCamera.transform.forward;
            var plane = new Plane(planeNormal, previousDragTarget - dragGrabOffset);
            if (!plane.Raycast(ray, out var distance))
                return false;

            targetPosition = ray.GetPoint(distance) + dragGrabOffset;
            return true;
        }

        private void UpdateDragVelocity(Vector3 targetPosition)
        {
            var now = Time.unscaledTime;
            if (hasDragTarget)
            {
                var deltaTime = Mathf.Max(0.0001f, now - previousDragTargetTime);
                dragVelocity = (targetPosition - previousDragTarget) / deltaTime;
            }

            previousDragTarget = targetPosition;
            previousDragTargetTime = now;
            hasDragTarget = true;
        }

        private void PublishDragState(Vector3 position, Vector3 linearVelocity, string phase)
        {
            if (!IsDragging || bridge == null) return;
            var applyTick = bridge.Tick + Mathf.Max(0, inputLeadTicks);
            if (lastDragApplyTick >= 0 && applyTick <= lastDragApplyTick)
                applyTick = lastDragApplyTick + 1;

            lastDragApplyTick = applyTick;
            var sequence = dragSequence++;
            var interactionId = string.IsNullOrWhiteSpace(draggingInteractionId)
                ? draggingObjectId + ":" + applyTick.ToString(System.Globalization.CultureInfo.InvariantCulture)
                : draggingInteractionId;
            var inputId = interactionId + ":" + sequence.ToString("D6", System.Globalization.CultureInfo.InvariantCulture);
            bridge.PublishTimelineBodyStateInput(
                draggingObjectId,
                applyTick,
                position,
                draggingRotation,
                linearVelocity,
                Vector3.zero,
                inputId,
                this,
                interactionId,
                sequence,
                phase,
                dragTimelineRevision,
                0L,
                dragBranchTick);
            nextInputPublishAt = Time.unscaledTime + Mathf.Max(0.005f, inputIntervalSeconds);
        }

        private void RefreshPickCollidersIfNeeded()
        {
            if (!autoAddPickColliders || Time.unscaledTime < nextColliderRefreshAt)
                return;

            nextColliderRefreshAt = Time.unscaledTime + Mathf.Max(0.1f, pickColliderRefreshInterval);
            var identities = FindObjectsByType<SceneSyncIdentity>(FindObjectsSortMode.None);
            foreach (var identity in identities)
            {
                if (identity == null ||
                    string.IsNullOrWhiteSpace(identity.ObjectId) ||
                    identity.GetComponentInChildren<Collider>() != null ||
                    bridge == null ||
                    !bridge.HasDynamicBody(identity.ObjectId))
                {
                    continue;
                }

                if (TryCalculateLocalRendererBounds(identity.transform, out var bounds))
                {
                    var collider = identity.gameObject.AddComponent<BoxCollider>();
                    collider.center = bounds.center;
                    collider.size = Vector3.Max(bounds.size, Vector3.one * 0.05f);
                }
            }
        }

        private static bool TryCalculateLocalRendererBounds(Transform root, out Bounds localBounds)
        {
            localBounds = new Bounds(Vector3.zero, Vector3.zero);
            if (root == null) return false;

            var renderers = root.GetComponentsInChildren<Renderer>(true);
            var hasBounds = false;
            foreach (var renderer in renderers)
            {
                if (renderer == null) continue;
                var bounds = renderer.bounds;
                var min = bounds.min;
                var max = bounds.max;
                var corners = new[]
                {
                    new Vector3(min.x, min.y, min.z),
                    new Vector3(min.x, min.y, max.z),
                    new Vector3(min.x, max.y, min.z),
                    new Vector3(min.x, max.y, max.z),
                    new Vector3(max.x, min.y, min.z),
                    new Vector3(max.x, min.y, max.z),
                    new Vector3(max.x, max.y, min.z),
                    new Vector3(max.x, max.y, max.z),
                };

                foreach (var corner in corners)
                {
                    var localPoint = root.InverseTransformPoint(corner);
                    if (hasBounds)
                    {
                        localBounds.Encapsulate(localPoint);
                    }
                    else
                    {
                        localBounds = new Bounds(localPoint, Vector3.zero);
                        hasBounds = true;
                    }
                }
            }

            return hasBounds;
        }

        private static float NormalizeAngle(float angle)
        {
            while (angle > 180f) angle -= 360f;
            while (angle < -180f) angle += 360f;
            return angle;
        }

        private struct SnapshotCorrectionOverrideState
        {
            public SnapshotCorrectionOverrideState(bool autoApplyRemoteSnapshots, bool requestSnapshotOnHashMismatch)
            {
                AutoApplyRemoteSnapshots = autoApplyRemoteSnapshots;
                RequestSnapshotOnHashMismatch = requestSnapshotOnHashMismatch;
                ReferenceCount = 1;
            }

            public bool AutoApplyRemoteSnapshots { get; }
            public bool RequestSnapshotOnHashMismatch { get; }
            public int ReferenceCount { get; set; }
        }
    }
}
