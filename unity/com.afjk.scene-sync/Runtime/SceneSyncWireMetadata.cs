using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Video;

namespace Afjk.SceneSync
{
    [DisallowMultipleComponent]
    public sealed class SceneSyncWireMetadata : MonoBehaviour
    {
        [SerializeField] private string assetJson;
        [SerializeField] private string metadataJson;

        public string AssetJson
        {
            get => assetJson;
            set => assetJson = value;
        }

        public string MetadataJson
        {
            get => metadataJson;
            set => metadataJson = value;
        }

        public void Configure(string newAssetJson, string newMetadataJson)
        {
            assetJson = string.IsNullOrWhiteSpace(newAssetJson) ? null : newAssetJson;
            metadataJson = string.IsNullOrWhiteSpace(newMetadataJson) ? null : newMetadataJson;
        }
    }

    public static class SceneSyncWireJson
    {
        public static string JsonEscape(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            return value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r");
        }

        public static string FormatFloat(float value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        public static string ExtractString(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(fieldName)) return null;
            var match = Regex.Match(
                json,
                "\"" + Regex.Escape(fieldName) + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"");
            if (!match.Success) return null;
            return UnescapeJsonString(match.Groups[1].Value);
        }

        public static string ExtractRawObject(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(fieldName)) return null;

            var token = "\"" + fieldName + "\"";
            var fieldIndex = json.IndexOf(token, StringComparison.Ordinal);
            if (fieldIndex < 0) return null;

            var colon = json.IndexOf(':', fieldIndex + token.Length);
            if (colon < 0) return null;

            var objectStart = json.IndexOf('{', colon + 1);
            if (objectStart < 0) return null;

            var objectEnd = FindMatching(json, objectStart, '{', '}');
            if (objectEnd < 0) return null;
            return json.Substring(objectStart, objectEnd - objectStart + 1);
        }

        public static List<KeyValuePair<string, string>> ExtractObjectMapEntries(string json, string fieldName)
        {
            var result = new List<KeyValuePair<string, string>>();
            var mapJson = ExtractRawObject(json, fieldName);
            if (string.IsNullOrEmpty(mapJson)) return result;

            var i = 1; // skip opening {
            while (i < mapJson.Length - 1)
            {
                SkipWhitespaceAndComma(mapJson, ref i);
                if (i >= mapJson.Length - 1 || mapJson[i] != '"') break;

                var keyEnd = FindStringEnd(mapJson, i);
                if (keyEnd < 0) break;
                var key = UnescapeJsonString(mapJson.Substring(i + 1, keyEnd - i - 1));
                i = keyEnd + 1;

                SkipWhitespace(mapJson, ref i);
                if (i >= mapJson.Length || mapJson[i] != ':') break;
                i++;
                SkipWhitespace(mapJson, ref i);
                if (i >= mapJson.Length || mapJson[i] != '{') break;

                var valueEnd = FindMatching(mapJson, i, '{', '}');
                if (valueEnd < 0) break;
                result.Add(new KeyValuePair<string, string>(key, mapJson.Substring(i, valueEnd - i + 1)));
                i = valueEnd + 1;
            }

            return result;
        }

        public static float[] ExtractArray(string json, string fieldName)
        {
            if (string.IsNullOrEmpty(json) || string.IsNullOrEmpty(fieldName)) return null;

            var key = "\"" + fieldName + "\"";
            var keyIndex = json.IndexOf(key, StringComparison.Ordinal);
            if (keyIndex < 0) return null;
            var start = json.IndexOf('[', keyIndex + key.Length);
            if (start < 0) return null;
            var end = json.IndexOf(']', start + 1);
            if (end < 0) return null;

            var nums = json.Substring(start + 1, end - start - 1).Split(',');
            var result = new float[nums.Length];
            for (var i = 0; i < nums.Length; i++)
            {
                if (float.TryParse(
                    nums[i].Trim(),
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out var f))
                {
                    result[i] = f;
                }
            }
            return result;
        }

        public static string BuildMeshAssetJson(string meshPath, string assetId, string visualBasis)
        {
            var builder = new StringBuilder();
            builder.Append("{\"type\":\"mesh\",\"source\":\"carrier\"");
            if (!string.IsNullOrEmpty(meshPath))
                builder.Append(",\"meshPath\":\"").Append(JsonEscape(meshPath)).Append("\"");
            if (!string.IsNullOrEmpty(assetId))
                builder.Append(",\"assetId\":\"").Append(JsonEscape(assetId)).Append("\"");
            if (!string.IsNullOrEmpty(visualBasis))
                builder.Append(",\"visualBasis\":\"").Append(JsonEscape(visualBasis)).Append("\"");
            builder.Append("}");
            return builder.ToString();
        }

        public static string BuildObjectJson(
            string objectId,
            string name,
            Vector3 position,
            Quaternion rotation,
            Vector3 scale,
            string meshPath,
            string assetId,
            string assetJson,
            string metadataJson)
        {
            var builder = new StringBuilder();
            builder.Append("\"").Append(JsonEscape(objectId)).Append("\":{");
            builder.Append("\"name\":\"").Append(JsonEscape(name)).Append("\"");
            builder.Append(",\"position\":[")
                .Append(FormatFloat(position.x)).Append(",")
                .Append(FormatFloat(position.y)).Append(",")
                .Append(FormatFloat(-position.z)).Append("]");
            builder.Append(",\"rotation\":[")
                .Append(FormatFloat(rotation.x)).Append(",")
                .Append(FormatFloat(rotation.y)).Append(",")
                .Append(FormatFloat(-rotation.z)).Append(",")
                .Append(FormatFloat(-rotation.w)).Append("]");
            builder.Append(",\"scale\":[")
                .Append(FormatFloat(scale.x)).Append(",")
                .Append(FormatFloat(scale.y)).Append(",")
                .Append(FormatFloat(scale.z)).Append("]");
            if (!string.IsNullOrEmpty(meshPath))
                builder.Append(",\"meshPath\":\"").Append(JsonEscape(meshPath)).Append("\"");
            if (!string.IsNullOrEmpty(assetId))
                builder.Append(",\"assetId\":\"").Append(JsonEscape(assetId)).Append("\"");
            if (!string.IsNullOrWhiteSpace(assetJson))
                builder.Append(",\"asset\":").Append(assetJson);
            if (!string.IsNullOrWhiteSpace(metadataJson))
                builder.Append(",\"metadata\":").Append(metadataJson);
            builder.Append("}");
            return builder.ToString();
        }

        public static string GetAssetType(string assetJson)
        {
            return ExtractString(assetJson, "type");
        }

        public static string GetAssetSource(string assetJson)
        {
            return ExtractString(assetJson, "source");
        }

        public static string GetAssetUrl(string assetJson)
        {
            return ExtractString(assetJson, "url");
        }

        public static string GetAssetPrimitive(string assetJson)
        {
            return ExtractString(assetJson, "primitive");
        }

        public static string GetAssetColor(string assetJson)
        {
            return ExtractString(assetJson, "color");
        }

        private static int FindMatching(string text, int start, char open, char close)
        {
            var depth = 0;
            var inString = false;
            var escape = false;

            for (var i = start; i < text.Length; i++)
            {
                var ch = text[i];
                if (escape)
                {
                    escape = false;
                    continue;
                }

                if (ch == '\\')
                {
                    escape = true;
                    continue;
                }

                if (ch == '"')
                {
                    inString = !inString;
                    continue;
                }

                if (inString) continue;

                if (ch == open) depth++;
                else if (ch == close)
                {
                    depth--;
                    if (depth == 0) return i;
                }
            }

            return -1;
        }

        private static int FindStringEnd(string text, int startQuote)
        {
            var escape = false;
            for (var i = startQuote + 1; i < text.Length; i++)
            {
                if (escape)
                {
                    escape = false;
                    continue;
                }
                if (text[i] == '\\')
                {
                    escape = true;
                    continue;
                }
                if (text[i] == '"') return i;
            }
            return -1;
        }

        private static void SkipWhitespaceAndComma(string text, ref int index)
        {
            while (index < text.Length && (char.IsWhiteSpace(text[index]) || text[index] == ','))
                index++;
        }

        private static void SkipWhitespace(string text, ref int index)
        {
            while (index < text.Length && char.IsWhiteSpace(text[index]))
                index++;
        }

        private static string UnescapeJsonString(string value)
        {
            if (string.IsNullOrEmpty(value)) return value;
            return value
                .Replace("\\\"", "\"")
                .Replace("\\\\", "\\")
                .Replace("\\n", "\n")
                .Replace("\\r", "\r")
                .Replace("\\t", "\t");
        }
    }

    public static class SceneSyncPanelFactory
    {
        private const int MaxTextLength = 512;
        private static readonly HttpClient Http = new HttpClient();

        public static GameObject CreateObjectForAsset(string name, string assetJson, string metadataJson)
        {
            var assetType = SceneSyncWireJson.GetAssetType(assetJson);
            GameObject go;

            switch (assetType)
            {
                case "primitive":
                    go = CreatePrimitive(assetJson);
                    go.name = name;
                    break;
                case "image":
                    go = CreatePanel(name, "ImagePanel");
                    _ = ApplyImageTexture(go, SceneSyncWireJson.GetAssetUrl(assetJson));
                    break;
                case "video":
                    go = CreatePanel(name, "VideoPanel");
                    ApplyVideoTexture(go, SceneSyncWireJson.GetAssetUrl(assetJson));
                    break;
                case "text":
                    go = CreateTextPanel(name, GetTextForAsset(assetJson));
                    break;
                default:
                    go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    go.name = name;
                    break;
            }

            var wire = EnsureWireMetadata(go);
            wire.Configure(assetJson, metadataJson);
            return go;
        }

        public static void ConfigureWireMetadata(
            GameObject go,
            string assetJson,
            string metadataJson,
            bool preserveMissing = false)
        {
            if (go == null) return;

            var wire = EnsureWireMetadata(go);
            var hasAsset = !string.IsNullOrWhiteSpace(assetJson);
            var hasMetadata = !string.IsNullOrWhiteSpace(metadataJson);
            var nextAssetJson = hasAsset || !preserveMissing ? assetJson : wire.AssetJson;
            var nextMetadataJson = hasMetadata || !preserveMissing ? metadataJson : wire.MetadataJson;

            wire.Configure(nextAssetJson, nextMetadataJson);

            if (!hasAsset) return;

            var assetType = SceneSyncWireJson.GetAssetType(assetJson);
            if (assetType == "image")
                _ = ApplyImageTexture(go, SceneSyncWireJson.GetAssetUrl(assetJson));
            else if (assetType == "video")
                ApplyVideoTexture(go, SceneSyncWireJson.GetAssetUrl(assetJson));
            else if (assetType == "text")
                ApplyText(go, GetTextForAsset(assetJson));
        }

        private static SceneSyncWireMetadata EnsureWireMetadata(GameObject go)
        {
            var metadata = go.GetComponent<SceneSyncWireMetadata>();
            if (metadata == null) metadata = go.AddComponent<SceneSyncWireMetadata>();
            return metadata;
        }

        private static GameObject CreatePrimitive(string assetJson)
        {
            var primitive = SceneSyncWireJson.GetAssetPrimitive(assetJson);
            var type = PrimitiveType.Cube;
            if (primitive == "sphere") type = PrimitiveType.Sphere;
            else if (primitive == "cylinder") type = PrimitiveType.Cylinder;
            else if (primitive == "plane") type = PrimitiveType.Plane;
            else if (primitive == "capsule") type = PrimitiveType.Capsule;

            var go = GameObject.CreatePrimitive(type);
            ApplyColor(go, SceneSyncWireJson.GetAssetColor(assetJson));
            return go;
        }

        private static GameObject CreatePanel(string name, string childName)
        {
            var go = new GameObject(name);
            var panel = GameObject.CreatePrimitive(PrimitiveType.Quad);
            panel.name = childName;
            panel.transform.SetParent(go.transform, worldPositionStays: false);
            panel.transform.localPosition = Vector3.zero;
            panel.transform.localRotation = Quaternion.identity;
            panel.transform.localScale = Vector3.one;
            return go;
        }

        private static GameObject CreateTextPanel(string name, string text)
        {
            var go = CreatePanel(name, "TextPanelBackground");
            ApplyColor(go.transform.GetChild(0).gameObject, "#202020");
            AddTextMesh(go, text);
            return go;
        }

        private static TextMesh AddTextMesh(GameObject root, string text)
        {
            var textObject = new GameObject("Text");
            textObject.transform.SetParent(root.transform, worldPositionStays: false);
            textObject.transform.localPosition = new Vector3(-0.45f, 0.2f, -0.01f);
            textObject.transform.localRotation = Quaternion.identity;
            textObject.transform.localScale = Vector3.one * 0.08f;

            var textMesh = textObject.AddComponent<TextMesh>();
            textMesh.text = LimitText(text);
            textMesh.anchor = TextAnchor.UpperLeft;
            textMesh.alignment = TextAlignment.Left;
            textMesh.fontSize = 32;
            textMesh.color = Color.white;
            return textMesh;
        }

        private static void ApplyText(GameObject root, string text)
        {
            if (root == null) return;
            var textMesh = root.GetComponentInChildren<TextMesh>();
            if (textMesh == null) textMesh = AddTextMesh(root, text);
            else textMesh.text = LimitText(text);
        }

        private static string GetTextForAsset(string assetJson)
        {
            return SceneSyncWireJson.ExtractString(assetJson, "text")
                ?? SceneSyncWireJson.GetAssetUrl(assetJson)
                ?? "Text";
        }

        private static string LimitText(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            return text.Length > MaxTextLength ? text.Substring(0, MaxTextLength) : text;
        }

        private static async Task ApplyImageTexture(GameObject root, string url)
        {
            if (root == null || string.IsNullOrWhiteSpace(url)) return;

            try
            {
                var bytes = await Http.GetByteArrayAsync(url);
                var texture = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (!texture.LoadImage(bytes)) return;
                texture.name = "SceneSyncImage";

                var renderer = root.GetComponentInChildren<Renderer>();
                if (renderer == null) return;
                var material = new Material(Shader.Find("Unlit/Texture") ?? Shader.Find("Standard"));
                material.mainTexture = texture;
                renderer.sharedMaterial = material;

                var aspect = texture.height > 0 ? (float)texture.width / texture.height : 1f;
                var panel = renderer.transform;
                panel.localScale = aspect >= 1f
                    ? new Vector3(Mathf.Min(aspect, 3f), 1f, 1f)
                    : new Vector3(1f, Mathf.Min(1f / aspect, 3f), 1f);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Failed to load image panel texture: " + ex.Message);
            }
        }

        private static void ApplyVideoTexture(GameObject root, string url)
        {
            if (root == null || string.IsNullOrWhiteSpace(url)) return;

            var renderer = root.GetComponentInChildren<Renderer>();
            if (renderer == null) return;

            var texture = renderer.sharedMaterial != null
                ? renderer.sharedMaterial.mainTexture as RenderTexture
                : null;
            if (texture == null)
            {
                texture = new RenderTexture(1024, 576, 0);
                texture.name = "SceneSyncVideo";
            }

            if (renderer.sharedMaterial == null || renderer.sharedMaterial.mainTexture != texture)
            {
                var material = new Material(Shader.Find("Unlit/Texture") ?? Shader.Find("Standard"));
                material.mainTexture = texture;
                renderer.sharedMaterial = material;
            }

            var player = root.GetComponent<VideoPlayer>();
            if (player == null) player = root.AddComponent<VideoPlayer>();
            else player.Stop();
            player.source = VideoSource.Url;
            player.url = url;
            player.isLooping = true;
            player.playOnAwake = true;
            player.renderMode = VideoRenderMode.RenderTexture;
            player.targetTexture = texture;
            player.audioOutputMode = VideoAudioOutputMode.None;
            player.prepareCompleted -= PlayPreparedVideo;
            player.prepareCompleted += PlayPreparedVideo;
            player.Prepare();
        }

        private static void PlayPreparedVideo(VideoPlayer player)
        {
            if (player != null) player.Play();
        }

        private static void ApplyColor(GameObject go, string htmlColor)
        {
            if (go == null || string.IsNullOrEmpty(htmlColor)) return;
            if (!ColorUtility.TryParseHtmlString(htmlColor, out var color)) return;
            var renderer = go.GetComponent<Renderer>();
            if (renderer == null) return;
            var material = new Material(Shader.Find("Standard"));
            material.color = color;
            renderer.sharedMaterial = material;
        }
    }
}
