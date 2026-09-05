import type { UsageApi } from '../../preload/index'

declare global {
  interface Window {
    usageApi: UsageApi
  }
}

export {}
