import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import { AppProviders } from "../src/components/providers/app-providers";
import { getRuntimeConfig } from "../src/lib/runtime-config.server";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans"
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono"
});

export const metadata: Metadata = {
  title: "Schizm",
  description: "Prompt-driven workspace for maintaining a living Obsidian document store."
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  const runtimeConfig = getRuntimeConfig();
  const serialized = JSON.stringify(runtimeConfig).replace(/</g, "\\u003c");
  const hydrationScript = `
    window.__SCHIZM_RUNTIME__ = ${serialized};
    try {
      const savedTheme = window.localStorage.getItem("schizm-theme");
      document.documentElement.dataset.theme = savedTheme || window.__SCHIZM_RUNTIME__.defaultTheme;
    } catch (_error) {
      document.documentElement.dataset.theme = window.__SCHIZM_RUNTIME__.defaultTheme;
    }
  `;

  return (
    <html
      lang="en"
      data-theme={runtimeConfig.defaultTheme}
      suppressHydrationWarning
      className={`${spaceGrotesk.variable} ${ibmPlexMono.variable}`}
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: hydrationScript }} />
        <AppProviders runtimeConfig={runtimeConfig}>{children}</AppProviders>
      </body>
    </html>
  );
}
