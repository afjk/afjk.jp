"use client";

import { useEffect } from "react";
import type { TweetEmbed } from "@/data/twitter";

declare global {
  interface Window {
    twttr?: {
      widgets: {
        load: (el?: HTMLElement) => void;
      };
    };
  }
}

function ensureTwitterScript() {
  if (typeof window === "undefined") return;
  const existing = document.querySelector<HTMLScriptElement>('script[src*="platform.twitter.com"]');
  if (existing) {
    window.twttr?.widgets.load();
    return;
  }
  const script = document.createElement("script");
  script.src = "https://platform.twitter.com/widgets.js";
  script.async = true;
  document.body.appendChild(script);
}

export function TwitterEmbed({ embed }: { embed: TweetEmbed }) {
  useEffect(() => {
    ensureTwitterScript();
  }, []);

  return <div className="tweet-embed" dangerouslySetInnerHTML={{ __html: embed.html }} />;
}
