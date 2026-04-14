using System;
using System.Text;

namespace Afjk.Pipe.Internal
{
    internal static class PipeUtils
    {
        private const string PathChars = "0123456789abcdefghijklmnopqrstuvwxyz";
        private static readonly Random Rng = new Random();

        /// <summary>
        /// ランダム 8 文字の英数字パスを生成する（JS の randPath と同等）。
        /// </summary>
        internal static string RandPath()
        {
            var sb = new StringBuilder(8);
            for (int i = 0; i < 8; i++)
                sb.Append(PathChars[Rng.Next(PathChars.Length)]);
            return sb.ToString();
        }

        /// <summary>バイト数を人間が読みやすい文字列に変換する（B / KB / MB / GB）。</summary>
        internal static string FormatBytes(long bytes)
        {
            if (bytes < 1024L)            return $"{bytes} B";
            if (bytes < 1024L * 1024)     return $"{bytes / 1024.0:0.#} KB";
            if (bytes < 1024L * 1024 * 1024) return $"{bytes / (1024.0 * 1024):0.##} MB";
            return $"{bytes / (1024.0 * 1024 * 1024):0.##} GB";
        }

        /// <summary>
        /// piping-server URL・afjk.jp/pipe# URL・プレーンパスのいずれかからパス部分を取り出す。
        /// 例: "https://afjk.jp/pipe/#abc12345" → "abc12345"
        ///     "https://pipe.afjk.jp/abc12345" → "abc12345"
        ///     "abc12345"                       → "abc12345"
        /// </summary>
        internal static string ParsePath(string input)
        {
            if (string.IsNullOrEmpty(input)) return input;
            input = input.Trim();

            if (Uri.TryCreate(input, UriKind.Absolute, out Uri uri))
            {
                // hash がある場合（afjk.jp/pipe/#path）
                if (!string.IsNullOrEmpty(uri.Fragment))
                    return Uri.UnescapeDataString(uri.Fragment.TrimStart('#'));
                // path がある場合（pipe.afjk.jp/path）
                return uri.AbsolutePath.TrimStart('/');
            }

            return input.TrimStart('/');
        }
    }
}
