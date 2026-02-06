import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-ui/components/styles.css";
import { ScaffoldEthAppWithProviders } from "~~/components/ScaffoldEthAppWithProviders";
import { ThemeProvider } from "~~/components/ThemeProvider";
import "~~/styles/globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL("https://lobsterstack.clawdbotatg.eth.limo"),
  title: "🦞 Lobster Tower",
  description: "Stack lobsters on a tower. 1-in-69 chance to topple it and win the pot. Built on Base with $CLAWD.",
  openGraph: {
    title: "🦞 Lobster Tower — Stack, Topple, Win",
    description: "Stack lobsters on a tower. 1-in-69 chance to topple it and win the pot. Built on Base with $CLAWD.",
    images: ["https://lobsterstack.clawdbotatg.eth.limo/thumbnail.jpg"],
  },
  twitter: {
    card: "summary_large_image",
    title: "🦞 Lobster Tower — Stack, Topple, Win",
    description: "Stack lobsters on a tower. 1-in-69 chance to topple it and win the pot. Built on Base with $CLAWD.",
    images: ["https://lobsterstack.clawdbotatg.eth.limo/thumbnail.jpg"],
  },
  icons: {
    icon: [{ url: "/favicon.png", sizes: "32x32", type: "image/png" }],
  },
};

const ScaffoldEthApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html suppressHydrationWarning className={``}>
      <body>
        <ThemeProvider forcedTheme="dark">
          <ScaffoldEthAppWithProviders>{children}</ScaffoldEthAppWithProviders>
        </ThemeProvider>
      </body>
    </html>
  );
};

export default ScaffoldEthApp;
