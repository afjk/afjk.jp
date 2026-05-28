using System;
using System.Collections.Generic;
using Loomlet.Runtime;
using UnityEngine;

namespace Afjk.SceneSync
{
    [ExecuteAlways]
    [DisallowMultipleComponent]
    public sealed class SceneSyncLoomletBehaviour : MonoBehaviour
    {
        private static readonly HashSet<string> SceneNodeTypes = new HashSet<string>
        {
            "sceneSetPosition",
            "sceneOffsetPosition",
            "sceneSetRotation",
            "sceneSetScale",
            "sceneSetColor",
            "sceneSetVisible",
            "scene.setPosition",
            "scene.offsetPosition",
            "scene.setRotation",
            "scene.setScale",
            "scene.setColor",
            "scene.setVisible"
        };

        [SerializeField] private string objectId;
        [SerializeField] private bool sceneScope;
        [SerializeField] private string graphJson;
        [SerializeField] private SceneSyncManager manager;

        private LoomletEvaluator _evaluator;
        private LoomletEvaluationContext _context;
        private double _lastTime;
        private double _startedAt;
        private readonly Dictionary<string, Vector3> _offsetBasePositions = new Dictionary<string, Vector3>();

        public string ObjectId => objectId;
        public bool SceneScope => sceneScope;
        public string GraphJson => graphJson;

        public static SceneSyncLoomletBehaviour SetObjectGraph(GameObject go, SceneSyncManager owner, string targetObjectId, string rawGraphJson)
        {
            if (go == null || string.IsNullOrWhiteSpace(rawGraphJson)) return null;

            var runner = go.GetComponent<SceneSyncLoomletBehaviour>();
            if (runner == null) runner = go.AddComponent<SceneSyncLoomletBehaviour>();
            runner.Configure(owner, targetObjectId, rawGraphJson, isSceneScope: false);
            return runner;
        }

        public static void ClearObjectGraph(GameObject go)
        {
            var runner = go != null ? go.GetComponent<SceneSyncLoomletBehaviour>() : null;
            if (runner == null) return;
            runner.ClearGraph(restoreBases: true);
            DestroyRunner(runner);
        }

        public static SceneSyncLoomletBehaviour SetSceneGraph(SceneSyncManager owner, string rawGraphJson)
        {
            if (owner == null || string.IsNullOrWhiteSpace(rawGraphJson)) return null;

            var runner = owner.GetComponent<SceneSyncLoomletBehaviour>();
            if (runner == null) runner = owner.gameObject.AddComponent<SceneSyncLoomletBehaviour>();
            runner.Configure(owner, null, rawGraphJson, isSceneScope: true);
            return runner;
        }

        public static void ClearSceneGraph(SceneSyncManager owner)
        {
            var runner = owner != null ? owner.GetComponent<SceneSyncLoomletBehaviour>() : null;
            if (runner == null || !runner.sceneScope) return;
            runner.ClearGraph(restoreBases: true);
            DestroyRunner(runner);
        }

        public void Configure(SceneSyncManager owner, string targetObjectId, string rawGraphJson, bool isSceneScope)
        {
            ClearGraph(restoreBases: true);

            manager = owner;
            objectId = targetObjectId;
            sceneScope = isSceneScope;
            graphJson = rawGraphJson;
            _context = new LoomletEvaluationContext();
            _startedAt = Time.realtimeSinceStartup;
            _lastTime = _startedAt;

            var graph = LoomletGraph.FromJson(graphJson);
            if (!sceneScope)
                InjectObjectScopeTarget(graph, targetObjectId);
            _evaluator = new LoomletEvaluator(graph, CreateSceneSyncRegistry());
        }

        public void ClearGraph(bool restoreBases)
        {
            if (restoreBases) RestoreOffsetBases();
            _evaluator = null;
            _context = null;
            graphJson = null;
        }

        private void Update()
        {
            if (_evaluator == null) return;

            var now = (double)Time.realtimeSinceStartup;
            var elapsed = now - _startedAt;
            var delta = Math.Max(0, now - _lastTime);
            _lastTime = now;

            try
            {
                _context.WithSceneClock(elapsed, delta, false, "server", 1.0);
                _evaluator.Evaluate(_context);
            }
            catch (Exception error)
            {
                Debug.LogWarning("[SceneSync] Loomlet graph evaluation failed: " + error.Message);
                _evaluator = null;
            }
        }

        private LoomletFunctionRegistry CreateSceneSyncRegistry()
        {
            var registry = LoomletFunctionRegistry.CreateDefault();

            registry.Register("constant", new[] { "value" }, (inputs, context) => Out(Number(inputs, "value")));
            registry.Register("serverClock", new string[0], (inputs, context) => new Dictionary<string, object> { ["t"] = context.Time });
            registry.Register("sine", new[] { "t", "freq", "amplitude", "phase", "offset" }, (inputs, context) => Out(
                Math.Sin(Number(inputs, "t") * Number(inputs, "freq", 1) * 2 * Math.PI + Number(inputs, "phase")) *
                Number(inputs, "amplitude", 1) + Number(inputs, "offset")));
            registry.Register("cosine", new[] { "t", "freq", "amplitude", "phase", "offset" }, (inputs, context) => Out(
                Math.Cos(Number(inputs, "t") * Number(inputs, "freq", 1) * 2 * Math.PI + Number(inputs, "phase")) *
                Number(inputs, "amplitude", 1) + Number(inputs, "offset")));
            registry.Register("add", new[] { "a", "b" }, (inputs, context) => Out(Number(inputs, "a") + Number(inputs, "b")));
            registry.Register("multiply", new[] { "a", "b" }, (inputs, context) => Out(Number(inputs, "a", 1) * Number(inputs, "b", 1)));

            RegisterSceneNode(registry, "sceneSetPosition", ApplySetPosition);
            RegisterSceneNode(registry, "scene.setPosition", ApplySetPosition);
            RegisterSceneNode(registry, "sceneOffsetPosition", ApplyOffsetPosition);
            RegisterSceneNode(registry, "scene.offsetPosition", ApplyOffsetPosition);
            RegisterSceneNode(registry, "sceneSetRotation", ApplySetRotation);
            RegisterSceneNode(registry, "scene.setRotation", ApplySetRotation);
            RegisterSceneNode(registry, "sceneSetScale", ApplySetScale);
            RegisterSceneNode(registry, "scene.setScale", ApplySetScale);
            RegisterSceneNode(registry, "sceneSetColor", ApplySetColor);
            RegisterSceneNode(registry, "scene.setColor", ApplySetColor);
            RegisterSceneNode(registry, "sceneSetVisible", ApplySetVisible);
            RegisterSceneNode(registry, "scene.setVisible", ApplySetVisible);

            return registry;
        }

        private static void RegisterSceneNode(
            LoomletFunctionRegistry registry,
            string type,
            Func<Dictionary<string, object>, Dictionary<string, object>> evaluate)
        {
            registry.Register(
                type,
                new[] { "objectId", "target", "x", "y", "z", "w", "r", "g", "b", "visible" },
                (inputs, context) => evaluate(inputs));
        }

        private Dictionary<string, object> ApplySetPosition(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target != null)
                target.transform.position = new Vector3(
                    (float)Number(inputs, "x"),
                    (float)Number(inputs, "y"),
                    (float)-Number(inputs, "z"));
            return Empty();
        }

        private Dictionary<string, object> ApplyOffsetPosition(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            var targetId = ResolveGraphTargetId(inputs) ?? target?.GetInstanceID().ToString();
            if (target != null && !string.IsNullOrWhiteSpace(targetId))
            {
                if (!_offsetBasePositions.ContainsKey(targetId))
                    _offsetBasePositions[targetId] = target.transform.position;
                var basePosition = _offsetBasePositions[targetId];
                target.transform.position = basePosition + new Vector3(
                    (float)Number(inputs, "x"),
                    (float)Number(inputs, "y"),
                    (float)-Number(inputs, "z"));
            }
            return Empty();
        }

        private Dictionary<string, object> ApplySetRotation(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target != null)
            {
                var x = (float)(Number(inputs, "x") * Mathf.Rad2Deg);
                var y = (float)(Number(inputs, "y") * Mathf.Rad2Deg);
                var z = (float)(-Number(inputs, "z") * Mathf.Rad2Deg);
                target.transform.localEulerAngles = new Vector3(x, y, z);
            }
            return Empty();
        }

        private Dictionary<string, object> ApplySetScale(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target != null)
                target.transform.localScale = new Vector3(
                    (float)Number(inputs, "x", 1),
                    (float)Number(inputs, "y", 1),
                    (float)Number(inputs, "z", 1));
            return Empty();
        }

        private Dictionary<string, object> ApplySetColor(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target == null) return Empty();

            var color = new Color(
                (float)Number(inputs, "r", 1),
                (float)Number(inputs, "g", 1),
                (float)Number(inputs, "b", 1));
            foreach (var renderer in target.GetComponentsInChildren<Renderer>(true))
            {
                if (renderer == null || renderer.material == null) continue;
                var next = color;
                next.a = renderer.material.color.a;
                renderer.material.color = next;
            }
            return Empty();
        }

        private Dictionary<string, object> ApplySetVisible(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target != null)
                target.SetActive(Bool(inputs, "visible", true));
            return Empty();
        }

        private GameObject ResolveGraphTarget(Dictionary<string, object> inputs)
        {
            var targetId = ResolveGraphTargetId(inputs);
            if (string.IsNullOrWhiteSpace(targetId)) return gameObject;
            if (!sceneScope && targetId == objectId) return gameObject;
            return manager != null ? manager.FindSceneSyncObject(targetId) : null;
        }

        private string ResolveGraphTargetId(Dictionary<string, object> inputs)
        {
            var explicitObjectId = Text(inputs, "objectId");
            if (!string.IsNullOrWhiteSpace(explicitObjectId)) return explicitObjectId;

            var target = Text(inputs, "target");
            if (!string.IsNullOrWhiteSpace(target)) return target;

            return sceneScope ? null : objectId;
        }

        private void RestoreOffsetBases()
        {
            foreach (var pair in _offsetBasePositions)
            {
                var target = pair.Key == objectId ? gameObject : manager != null ? manager.FindSceneSyncObject(pair.Key) : null;
                if (target != null) target.transform.position = pair.Value;
            }
            _offsetBasePositions.Clear();
        }

        private static void InjectObjectScopeTarget(LoomletGraph graph, string targetObjectId)
        {
            if (graph == null || string.IsNullOrWhiteSpace(targetObjectId)) return;

            foreach (var node in graph.Nodes)
            {
                if (node == null || !SceneNodeTypes.Contains(node.Type)) continue;
                if (node.Params == null) node.Params = new Dictionary<string, object>();
                if (!node.Params.ContainsKey("target") && !node.Params.ContainsKey("objectId"))
                    node.Params["target"] = targetObjectId;
            }
        }

        private static Dictionary<string, object> Out(object value) => new Dictionary<string, object> { ["out"] = value };
        private static Dictionary<string, object> Empty() => new Dictionary<string, object>();

        private static double Number(Dictionary<string, object> inputs, string key, double fallback = 0)
        {
            if (inputs == null || !inputs.TryGetValue(key, out var value) || value == null) return fallback;
            try { return Convert.ToDouble(value); }
            catch { return fallback; }
        }

        private static bool Bool(Dictionary<string, object> inputs, string key, bool fallback)
        {
            if (inputs == null || !inputs.TryGetValue(key, out var value) || value == null) return fallback;
            if (value is bool b) return b;
            if (bool.TryParse(value.ToString(), out var parsed)) return parsed;
            return fallback;
        }

        private static string Text(Dictionary<string, object> inputs, string key)
        {
            if (inputs == null || !inputs.TryGetValue(key, out var value) || value == null) return null;
            return value.ToString();
        }

        private static void DestroyRunner(SceneSyncLoomletBehaviour runner)
        {
            if (runner == null) return;
            if (Application.isPlaying) Destroy(runner);
            else DestroyImmediate(runner);
        }
    }
}
