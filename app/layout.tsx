import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://relay-agent-operations.abc123xyza.chatgpt.site'),
  title: 'Relay — Agent Operations',
  description: 'Build, deploy, observe, and improve production AI agents.',
  openGraph: {
    title: 'Relay — Agent Operations',
    description: 'Build, deploy, observe, and improve production AI agents.',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1536,
        height: 1024,
        alt: 'Relay — Build. Deploy. Observe. Improve.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Relay — Agent Operations',
    description: 'Build, deploy, observe, and improve production AI agents.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}</body>
    </html>
  );
}
