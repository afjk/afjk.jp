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

        private string draggingObjectId;
        private Quaternion draggingRotation = Quaternion.identity;
        private Vector3 dragGrabOffset;
        private Vector3 previousDragTarget;
        private Vector3 dragVelocity;
        private float previousDragTargetTime;
        private float nextInputPublishAt;
        private float nextColliderRefreshAt;
        private bool hasDragTarget;
        private bool looking;
        private Vector3 previousLookMousePosition;
        private float yaw;
        private float pitch;

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
                    PublishDragState(targetPosition, dragVelocity);
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
            draggingRotation = rotation;
            dragGrabOffset = position - hitPoint;
            previousDragTarget = position;
            dragVelocity = linearVelocity;
            previousDragTargetTime = Time.unscaledTime;
            nextInputPublishAt = 0f;
            hasDragTarget = true;
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
            PublishDragState(previousDragTarget, throwVelocity);
            ClearDrag();
        }

        private void ClearDrag()
        {
            draggingObjectId = null;
            draggingRotation = Quaternion.identity;
            dragGrabOffset = Vector3.zero;
            previousDragTarget = Vector3.zero;
            dragVelocity = Vector3.zero;
            previousDragTargetTime = 0f;
            nextInputPublishAt = 0f;
            hasDragTarget = false;
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

        private void PublishDragState(Vector3 position, Vector3 linearVelocity)
        {
            if (!IsDragging || bridge == null) return;
            var applyTick = bridge.Tick + Mathf.Max(0, inputLeadTicks);
            bridge.PublishBodyStateInput(
                draggingObjectId,
                applyTick,
                position,
                draggingRotation,
                linearVelocity,
                Vector3.zero,
                null,
                this);
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
    }
}
