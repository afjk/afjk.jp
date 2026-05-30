using System;
using System.Collections.Generic;
using Godot;
using Loomlet.Runtime;

[GlobalClass]
public partial class SceneSyncLoomletRunner : Node
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

    private readonly Dictionary<string, Node3D> _objects = new Dictionary<string, Node3D>();
    private readonly Dictionary<string, BoundGraph> _objectGraphs = new Dictionary<string, BoundGraph>();
    private BoundGraph _sceneGraph;

    public void BindObject(string objectId, Node3D target)
    {
        if (string.IsNullOrWhiteSpace(objectId) || target == null)
            return;

        _objects[objectId] = target;
        if (_objectGraphs.TryGetValue(objectId, out var graph))
            graph.Target = target;
    }

    public void UnbindObject(string objectId)
    {
        if (string.IsNullOrWhiteSpace(objectId))
            return;

        ClearObjectGraph(objectId);
        _objects.Remove(objectId);
    }

    public void SetSceneGraph(string graphJson)
    {
        ClearSceneGraph();
        if (string.IsNullOrWhiteSpace(graphJson))
            return;

        try
        {
            var graph = LoomletGraph.FromJson(graphJson);
            _sceneGraph = new BoundGraph(this, null, null, graph, graphJson, sceneScope: true);
        }
        catch (Exception error)
        {
            GD.PushWarning("[SceneSync] Failed to bind scene Loomlet graph: " + error.Message);
        }
    }

    public void ClearSceneGraph()
    {
        _sceneGraph?.Clear(restoreBases: true);
        _sceneGraph = null;
    }

    public void SetObjectGraph(string objectId, Node3D target, string graphJson)
    {
        if (string.IsNullOrWhiteSpace(objectId))
            return;

        ClearObjectGraph(objectId);
        if (target == null || string.IsNullOrWhiteSpace(graphJson))
            return;

        try
        {
            var graph = LoomletGraph.FromJson(graphJson);
            InjectObjectScopeTarget(graph, objectId);
            _objectGraphs[objectId] = new BoundGraph(this, objectId, target, graph, graphJson, sceneScope: false);
            _objects[objectId] = target;
        }
        catch (Exception error)
        {
            GD.PushWarning("[SceneSync] Failed to bind object Loomlet graph: " + error.Message);
        }
    }

    public void ClearObjectGraph(string objectId)
    {
        if (string.IsNullOrWhiteSpace(objectId))
            return;

        if (_objectGraphs.TryGetValue(objectId, out var graph))
        {
            graph.Clear(restoreBases: true);
            _objectGraphs.Remove(objectId);
        }
    }

    public override void _Process(double delta)
    {
        _sceneGraph?.Evaluate(delta);

        foreach (var graph in _objectGraphs.Values)
            graph.Evaluate(delta);
    }

    private Node3D ResolveTarget(string objectId)
    {
        if (string.IsNullOrWhiteSpace(objectId))
            return null;

        return _objects.TryGetValue(objectId, out var target) && GodotObject.IsInstanceValid(target)
            ? target
            : null;
    }

    private static LoomletFunctionRegistry CreateSceneSyncRegistry(BoundGraph bound)
    {
        var registry = LoomletFunctionRegistry.CreateDefault();

        registry.Register("constant", new[] { "value" }, (inputs, context) => Out(Number(inputs, "value")));
        registry.Register("clock", Array.Empty<string>(), (inputs, context) => new Dictionary<string, object> { ["t"] = context.Time });
        registry.Register("sine", new[] { "t", "freq", "amplitude", "phase", "offset" }, (inputs, context) => Out(
            Math.Sin(Number(inputs, "t") * Number(inputs, "freq", 1) * 2 * Math.PI + Number(inputs, "phase")) *
            Number(inputs, "amplitude", 1) + Number(inputs, "offset")));
        registry.Register("cosine", new[] { "t", "freq", "amplitude", "phase", "offset" }, (inputs, context) => Out(
            Math.Cos(Number(inputs, "t") * Number(inputs, "freq", 1) * 2 * Math.PI + Number(inputs, "phase")) *
            Number(inputs, "amplitude", 1) + Number(inputs, "offset")));
        registry.Register("add", new[] { "a", "b" }, (inputs, context) => Out(Number(inputs, "a") + Number(inputs, "b")));
        registry.Register("multiply", new[] { "a", "b" }, (inputs, context) => Out(Number(inputs, "a", 1) * Number(inputs, "b", 1)));

        RegisterSceneNode(registry, "sceneSetPosition", bound.ApplySetPosition);
        RegisterSceneNode(registry, "scene.setPosition", bound.ApplySetPosition);
        RegisterSceneNode(registry, "sceneOffsetPosition", bound.ApplyOffsetPosition);
        RegisterSceneNode(registry, "scene.offsetPosition", bound.ApplyOffsetPosition);
        RegisterSceneNode(registry, "sceneSetRotation", bound.ApplySetRotation);
        RegisterSceneNode(registry, "scene.setRotation", bound.ApplySetRotation);
        RegisterSceneNode(registry, "sceneSetScale", bound.ApplySetScale);
        RegisterSceneNode(registry, "scene.setScale", bound.ApplySetScale);
        RegisterSceneNode(registry, "sceneSetColor", bound.ApplySetColor);
        RegisterSceneNode(registry, "scene.setColor", bound.ApplySetColor);
        RegisterSceneNode(registry, "sceneSetVisible", bound.ApplySetVisible);
        RegisterSceneNode(registry, "scene.setVisible", bound.ApplySetVisible);

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

    private static void InjectObjectScopeTarget(LoomletGraph graph, string targetObjectId)
    {
        if (graph == null || string.IsNullOrWhiteSpace(targetObjectId))
            return;

        foreach (var node in graph.Nodes)
        {
            if (node == null || !SceneNodeTypes.Contains(node.Type))
                continue;
            if (node.Params == null)
                node.Params = new Dictionary<string, object>();
            if (!node.Params.ContainsKey("target") && !node.Params.ContainsKey("objectId"))
                node.Params["target"] = targetObjectId;
        }
    }

    private static Dictionary<string, object> Out(object value) => new Dictionary<string, object> { ["out"] = value };
    private static Dictionary<string, object> Empty() => new Dictionary<string, object>();

    private static double Number(Dictionary<string, object> inputs, string key, double fallback = 0)
    {
        if (inputs == null || !inputs.TryGetValue(key, out var value) || value == null)
            return fallback;
        try { return Convert.ToDouble(value); }
        catch { return fallback; }
    }

    private static bool Bool(Dictionary<string, object> inputs, string key, bool fallback)
    {
        if (inputs == null || !inputs.TryGetValue(key, out var value) || value == null)
            return fallback;
        if (value is bool b)
            return b;
        return bool.TryParse(value.ToString(), out var parsed) ? parsed : fallback;
    }

    private static string Text(Dictionary<string, object> inputs, string key)
    {
        if (inputs == null || !inputs.TryGetValue(key, out var value) || value == null)
            return null;
        return value.ToString();
    }

    private sealed class BoundGraph
    {
        private readonly SceneSyncLoomletRunner _owner;
        private readonly string _objectId;
        private readonly bool _sceneScope;
        private readonly LoomletEvaluator _evaluator;
        private readonly LoomletEvaluationContext _context = new LoomletEvaluationContext();
        private readonly Dictionary<string, Vector3> _offsetBasePositions = new Dictionary<string, Vector3>();
        private double _time;
        private bool _disabled;

        public BoundGraph(
            SceneSyncLoomletRunner owner,
            string objectId,
            Node3D target,
            LoomletGraph graph,
            string graphJson,
            bool sceneScope)
        {
            _owner = owner;
            _objectId = objectId;
            Target = target;
            GraphJson = graphJson;
            _sceneScope = sceneScope;
            _evaluator = new LoomletEvaluator(graph, CreateSceneSyncRegistry(this));
        }

        public Node3D Target { get; set; }
        public string GraphJson { get; }

        public void Evaluate(double delta)
        {
            if (_evaluator == null || _disabled)
                return;

            _time += Math.Max(0, delta);
            try
            {
                _context.WithSceneClock(_time, Math.Max(0, delta), false, "local", 1.0);
                _evaluator.Evaluate(_context);
            }
            catch (Exception error)
            {
                GD.PushWarning("[SceneSync] Loomlet graph evaluation failed: " + error.Message);
                _disabled = true;
            }
        }

        public void Clear(bool restoreBases)
        {
            if (restoreBases)
                RestoreOffsetBases();
        }

        public Dictionary<string, object> ApplySetPosition(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target != null)
            {
                target.GlobalPosition = new Vector3(
                    (float)Number(inputs, "x"),
                    (float)Number(inputs, "y"),
                    (float)Number(inputs, "z"));
            }
            return Empty();
        }

        public Dictionary<string, object> ApplyOffsetPosition(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            var targetId = ResolveGraphTargetId(inputs) ?? _objectId;
            if (target != null && !string.IsNullOrWhiteSpace(targetId))
            {
                if (!_offsetBasePositions.ContainsKey(targetId))
                    _offsetBasePositions[targetId] = target.GlobalPosition;
                var basePosition = _offsetBasePositions[targetId];
                target.GlobalPosition = basePosition + new Vector3(
                    (float)Number(inputs, "x"),
                    (float)Number(inputs, "y"),
                    (float)Number(inputs, "z"));
            }
            return Empty();
        }

        public Dictionary<string, object> ApplySetRotation(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target != null)
            {
                target.Rotation = new Vector3(
                    (float)Number(inputs, "x"),
                    (float)Number(inputs, "y"),
                    (float)Number(inputs, "z"));
            }
            return Empty();
        }

        public Dictionary<string, object> ApplySetScale(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target != null)
            {
                target.Scale = new Vector3(
                    (float)Number(inputs, "x", 1),
                    (float)Number(inputs, "y", 1),
                    (float)Number(inputs, "z", 1));
            }
            return Empty();
        }

        public Dictionary<string, object> ApplySetColor(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target == null)
                return Empty();

            var color = new Color(
                (float)Number(inputs, "r", 1),
                (float)Number(inputs, "g", 1),
                (float)Number(inputs, "b", 1));
            ApplyColorRecursive(target, color);
            return Empty();
        }

        public Dictionary<string, object> ApplySetVisible(Dictionary<string, object> inputs)
        {
            var target = ResolveGraphTarget(inputs);
            if (target != null)
                target.Visible = Bool(inputs, "visible", true);
            return Empty();
        }

        private Node3D ResolveGraphTarget(Dictionary<string, object> inputs)
        {
            var targetId = ResolveGraphTargetId(inputs);
            if (string.IsNullOrWhiteSpace(targetId))
                return _sceneScope ? null : Target;
            if (!_sceneScope && targetId == _objectId)
                return Target;
            return _owner.ResolveTarget(targetId);
        }

        private string ResolveGraphTargetId(Dictionary<string, object> inputs)
        {
            var explicitObjectId = Text(inputs, "objectId");
            if (!string.IsNullOrWhiteSpace(explicitObjectId))
                return explicitObjectId;

            var target = Text(inputs, "target");
            if (!string.IsNullOrWhiteSpace(target))
                return target;

            return _sceneScope ? null : _objectId;
        }

        private void RestoreOffsetBases()
        {
            foreach (var pair in _offsetBasePositions)
            {
                var target = pair.Key == _objectId ? Target : _owner.ResolveTarget(pair.Key);
                if (target != null)
                    target.GlobalPosition = pair.Value;
            }
            _offsetBasePositions.Clear();
        }

        private static void ApplyColorRecursive(Node node, Color color)
        {
            if (node is MeshInstance3D meshInstance)
            {
                var material = meshInstance.MaterialOverride as StandardMaterial3D;
                material = material != null
                    ? (StandardMaterial3D)material.Duplicate()
                    : new StandardMaterial3D();
                color.A = material.AlbedoColor.A;
                material.AlbedoColor = color;
                meshInstance.MaterialOverride = material;
            }

            foreach (var child in node.GetChildren())
                ApplyColorRecursive(child, color);
        }
    }
}
