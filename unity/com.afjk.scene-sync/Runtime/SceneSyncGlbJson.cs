using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Afjk.SceneSync
{
    /// <summary>
    /// GLB の JSON chunk を読むための最小 JSON リーダー。
    ///
    /// glTF の attribute 名には <c>KHR_gaussian_splatting:ROTATION</c> のような
    /// 動的キーが含まれるため、<see cref="UnityEngine.JsonUtility"/> では扱えない。
    /// Scene Sync は KHR_gaussian_splatting の検出にしかこの JSON を使わないので、
    /// 依存を増やさずに済むよう必要最小限のリーダーだけを持つ。
    ///
    /// 値は object / List&lt;object&gt; / string / double / bool / null に写す。
    /// </summary>
    public static class SceneSyncGlbJson
    {
        /// <summary>入れ子の深さ上限。壊れた入力でスタックを潰さないためのガード。</summary>
        public const int MaxDepth = 64;

        public static bool TryParse(string text, out object value, out string error)
        {
            value = null;
            error = null;

            if (string.IsNullOrEmpty(text))
            {
                error = "JSON text is empty";
                return false;
            }

            var index = 0;
            try
            {
                var parsed = ParseValue(text, ref index, 0);
                SkipWhitespace(text, ref index);
                if (index != text.Length)
                {
                    error = "Unexpected trailing characters at offset " + index;
                    return false;
                }

                value = parsed;
                return true;
            }
            catch (FormatException err)
            {
                error = err.Message;
                return false;
            }
        }

        public static Dictionary<string, object> AsObject(object value)
        {
            return value as Dictionary<string, object>;
        }

        public static List<object> AsArray(object value)
        {
            return value as List<object>;
        }

        public static string AsString(object value)
        {
            return value as string;
        }

        /// <summary>オブジェクトのキーを引く。オブジェクトでない場合や未定義なら null。</summary>
        public static object Get(object owner, string key)
        {
            var map = AsObject(owner);
            if (map == null) return null;

            object result;
            return map.TryGetValue(key, out result) ? result : null;
        }

        /// <summary>JSON number を整数として読む。小数や非数値は false。</summary>
        public static bool TryGetInt(object value, out int result)
        {
            result = 0;
            if (!(value is double)) return false;

            var number = (double)value;
            if (double.IsNaN(number) || double.IsInfinity(number)) return false;
            if (number < int.MinValue || number > int.MaxValue) return false;
            if (Math.Abs(number - Math.Round(number)) > double.Epsilon) return false;

            result = (int)Math.Round(number);
            return true;
        }

        public static int GetInt(object owner, string key, int fallback)
        {
            int result;
            return TryGetInt(Get(owner, key), out result) ? result : fallback;
        }

        public static bool GetBool(object owner, string key, bool fallback)
        {
            var value = Get(owner, key);
            return value is bool ? (bool)value : fallback;
        }

        /// <summary>文字列配列を読む。要素が文字列でない場合は読み飛ばす。</summary>
        public static List<string> GetStringList(object owner, string key)
        {
            var result = new List<string>();
            var array = AsArray(Get(owner, key));
            if (array == null) return result;

            foreach (var entry in array)
            {
                var text = AsString(entry);
                if (text != null) result.Add(text);
            }

            return result;
        }

        private static object ParseValue(string text, ref int index, int depth)
        {
            if (depth > MaxDepth) throw new FormatException("JSON nesting is too deep");

            SkipWhitespace(text, ref index);
            if (index >= text.Length) throw new FormatException("Unexpected end of JSON");

            var c = text[index];
            switch (c)
            {
                case '{': return ParseObject(text, ref index, depth);
                case '[': return ParseArray(text, ref index, depth);
                case '"': return ParseString(text, ref index);
                case 't': Expect(text, ref index, "true"); return true;
                case 'f': Expect(text, ref index, "false"); return false;
                case 'n': Expect(text, ref index, "null"); return null;
                default: return ParseNumber(text, ref index);
            }
        }

        private static Dictionary<string, object> ParseObject(string text, ref int index, int depth)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            index++; // '{'

            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == '}')
            {
                index++;
                return result;
            }

            while (true)
            {
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != '"')
                    throw new FormatException("Expected a JSON object key at offset " + index);

                var key = ParseString(text, ref index);
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != ':')
                    throw new FormatException("Expected ':' at offset " + index);
                index++;

                result[key] = ParseValue(text, ref index, depth + 1);

                SkipWhitespace(text, ref index);
                if (index >= text.Length) throw new FormatException("Unterminated JSON object");
                if (text[index] == ',')
                {
                    index++;
                    continue;
                }

                if (text[index] == '}')
                {
                    index++;
                    return result;
                }

                throw new FormatException("Expected ',' or '}' at offset " + index);
            }
        }

        private static List<object> ParseArray(string text, ref int index, int depth)
        {
            var result = new List<object>();
            index++; // '['

            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == ']')
            {
                index++;
                return result;
            }

            while (true)
            {
                result.Add(ParseValue(text, ref index, depth + 1));

                SkipWhitespace(text, ref index);
                if (index >= text.Length) throw new FormatException("Unterminated JSON array");
                if (text[index] == ',')
                {
                    index++;
                    continue;
                }

                if (text[index] == ']')
                {
                    index++;
                    return result;
                }

                throw new FormatException("Expected ',' or ']' at offset " + index);
            }
        }

        private static string ParseString(string text, ref int index)
        {
            index++; // opening quote
            var builder = new StringBuilder();

            while (index < text.Length)
            {
                var c = text[index++];
                if (c == '"') return builder.ToString();

                if (c != '\\')
                {
                    builder.Append(c);
                    continue;
                }

                if (index >= text.Length) break;
                var escape = text[index++];
                switch (escape)
                {
                    case '"': builder.Append('"'); break;
                    case '\\': builder.Append('\\'); break;
                    case '/': builder.Append('/'); break;
                    case 'b': builder.Append('\b'); break;
                    case 'f': builder.Append('\f'); break;
                    case 'n': builder.Append('\n'); break;
                    case 'r': builder.Append('\r'); break;
                    case 't': builder.Append('\t'); break;
                    case 'u':
                        if (index + 4 > text.Length)
                            throw new FormatException("Truncated \\u escape at offset " + index);
                        var hex = text.Substring(index, 4);
                        int code;
                        if (!int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                            throw new FormatException("Invalid \\u escape at offset " + index);
                        builder.Append((char)code);
                        index += 4;
                        break;
                    default:
                        throw new FormatException("Unknown escape '\\" + escape + "' at offset " + index);
                }
            }

            throw new FormatException("Unterminated JSON string");
        }

        private static double ParseNumber(string text, ref int index)
        {
            var start = index;
            if (index < text.Length && (text[index] == '-' || text[index] == '+')) index++;

            while (index < text.Length)
            {
                var c = text[index];
                if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')
                {
                    index++;
                    continue;
                }

                break;
            }

            var slice = text.Substring(start, index - start);
            double value;
            if (!double.TryParse(slice, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
                throw new FormatException("Invalid JSON number '" + slice + "' at offset " + start);

            return value;
        }

        private static void Expect(string text, ref int index, string literal)
        {
            if (index + literal.Length > text.Length
                || string.CompareOrdinal(text, index, literal, 0, literal.Length) != 0)
            {
                throw new FormatException("Expected '" + literal + "' at offset " + index);
            }

            index += literal.Length;
        }

        private static void SkipWhitespace(string text, ref int index)
        {
            while (index < text.Length)
            {
                var c = text[index];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\0')
                {
                    index++;
                    continue;
                }

                break;
            }
        }
    }
}
