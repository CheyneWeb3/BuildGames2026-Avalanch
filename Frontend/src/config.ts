// src/config.ts
import { EthersAdapter } from '@reown/appkit-adapter-ethers';
import { defineChain } from '@reown/appkit/networks';
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useAppKitEvents,
  useAppKitNetwork,
  useAppKitState,
  useAppKitTheme,
  useDisconnect,
  useAppKitProvider,
  useWalletInfo,
} from '@reown/appkit/react';

export const projectId = 'e31b5e502fb33fc911602bd2960161fa';

const ethersAdapter = new EthersAdapter();

export const avalanche = defineChain({
  id: 43114,
  caipNetworkId: 'eip155:43114',
  chainNamespace: 'eip155',
  name: 'Avax',
  nativeCurrency: { decimals: 18, name: 'AVAX', symbol: 'AVAX' },
  rpcUrls: {
    default: {
      http: ['https://api.avax.network/ext/bc/C/rpc'],
      webSocket: []
    }
  },
  blockExplorers: {
    default: { name: 'SnowTrace', url: 'https://snowtrace.io' }
  },
  contracts: {}
})

export const fujiavalanche = defineChain({
  id: 43113,
  caipNetworkId: 'eip155:43113',
  chainNamespace: 'eip155',
  name: 'Avalanche Fuji',
  nativeCurrency: { decimals: 18, name: 'AVAX', symbol: 'AVAX' },
  rpcUrls: {
    default: {
      http: ['https://api.avax-test.network/ext/bc/C/rpc'],
      webSocket: [],
    },
  },
  blockExplorers: {
    default: { name: 'Snowtrace Testnet', url: 'https://testnet.snowtrace.io' },
  },
  contracts: {},
});


export const appKitThemeVariables: Record<string, Record<string, string>> = {
  dark: {
    '--w3m-color-mix': '#90caf9',
    '--w3m-color-mix-strength': '80',
    '--w3m-accent': '#1e1e1e',
  },

  midnight: {
        '--w3m-accent': '#f5b749',
        '--w3m-accent-fill': '#e28c2c',
        '--w3m-color-bg-1': '#0c0805',
        '--w3m-color-bg-2': '#100c08',
        '--w3m-color-bg-3': '#15100a',
        '--w3m-color-overlay': 'rgba(0, 0, 0, 0.7)',
        '--w3m-color-fg-1': '#fdb927',
        '--w3m-color-fg-2': '#f5b749',
        '--w3m-color-fg-3': '#d69e2e',
        '--w3m-border': '1px solid rgba(220, 160, 50, 0.45)',
        '--w3m-button-background': '#f5b749',
        '--w3m-button-background-hover': '#e28c2c',
        '--w3m-button-foreground': '#000000',
        '--w3m-button-border': '#000000',
        '--w3m-color-success': '#34d399',
        '--w3m-border-radius-master': '2px',
        '--w3m-color-mix': '#2b1707',
        '--w3m-color-mix-strength': '10',
      },
};

type AppKitThemeName = keyof typeof appKitThemeVariables;
const defaultThemeName: AppKitThemeName = 'midnight';


const modal = createAppKit({
  adapters: [ethersAdapter],
  networks: [

      // avalanche,
      fujiavalanche,

  ],
  defaultNetwork: fujiavalanche,
  metadata: {
    name: '',
    description: '',
    url: typeof window !== 'undefined' ? window.location.origin : '',
    icons: [''],
  },
  enableWalletGuide: false,
  projectId,

  themeMode: 'light',
  themeVariables: appKitThemeVariables[defaultThemeName],

  features: {
    analytics: true,
    swaps: true,
    onramp: true,
    enableReconnect: true,
    enableMobileFullScreen: true,
    enableNetworkSwitch: true,
    legalCheckbox: false,
    email: false,
    socials: [],
    emailShowWallets: false,
  },
  featuredWalletIds: [
    'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96',
    '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0',
    'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa',
  ],

    chainImages: {

      43114: 'https://assets.coingecko.com/coins/images/22943/thumb/AVAX_wh_small.png?1696522240',
      43113: 'https://assets.coingecko.com/coins/images/22943/thumb/AVAX_wh_small.png?1696522240',

  },
});

export {
  modal,
  useAppKit,
  useAppKitState,
  useAppKitTheme,
  useAppKitEvents,
  useAppKitAccount,
  useWalletInfo,
  useAppKitNetwork,
  useAppKitProvider,
  useDisconnect,
};

export const allChains = [

  // avalanche,
  fujiavalanche,



];

export function getChainById(id: number) {
  return allChains.find((c: any) => c && typeof c.id === 'number' && c.id === id);
}

export function getChainByName(name: string) {
  const n = String(name).toLowerCase();
  return allChains.find((c: any) => c && String(c.name).toLowerCase() === n);
}
