import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-ui/components/styles.css";
import { ScaffoldEthAppWithProviders } from "~~/components/ScaffoldEthAppWithProviders";
import { ThemeProvider } from "~~/components/ThemeProvider";
import "~~/styles/globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "🦞 Lobster Stack",
  description: "Stack lobsters, earn CLAWD. A pyramid of crustacean gains on Base.",
  openGraph: {
    title: "🦞 Lobster Stack — Stack Lobsters, Earn CLAWD",
    description: "Stack lobsters, earn CLAWD. A pyramid of crustacean gains on Base.",
    images: ["/thumbnail.jpg"],
  },
  twitter: {
    card: "summary_large_image",
    title: "🦞 Lobster Stack — Stack Lobsters, Earn CLAWD",
    description: "Stack lobsters, earn CLAWD. A pyramid of crustacean gains on Base.",
    images: ["/thumbnail.jpg"],
  },
  icons: {
    icon: [{ url: "/favicon.png", sizes: "32x32", type: "image/png" }],
  },
};

const ScaffoldEthApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html suppressHydrationWarning className={``}>
      <body>
        <ThemeProvider enableSystem>
          <ScaffoldEthAppWithProviders>{children}</ScaffoldEthAppWithProviders>
        </ThemeProvider>
      </body>
    </html>
  );
};

export default ScaffoldEthApp;
