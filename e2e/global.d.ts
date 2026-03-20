interface BrowserTestResults {
  zstdRoundTrip: boolean;
  gzipRoundTrip: boolean;
  deflateRoundTrip: boolean;
  brotliRoundTrip: boolean;
  autoDetect: boolean;
  version: string;
  streaming: boolean;
  streamingError?: string;
}

interface Window {
  __results: BrowserTestResults;
  __ready: boolean;
  __error?: string;
}
