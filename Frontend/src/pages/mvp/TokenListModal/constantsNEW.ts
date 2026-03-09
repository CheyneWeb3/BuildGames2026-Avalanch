// src/constantsNEW.ts
import * as React from 'react';
import { JsonRpcProvider } from 'ethers';
import { useAppKitNetwork } from '../../../config';
//Globals not for a specific chain
export const DEF_SLIPPAGE = 565;
export const REFRESH_MS = 10_000;
export const FACTORY_SCAN_LAST_N = 400;

export const API_BASE = 'https://server.foxyswap.net';
export const QUOTE_API_ROOT  = 'https://server.foxyswap.net/api/quote';
export const PRICES_API_ROOT = 'https://server.foxyswap.net/api';
export const TOKEN_LIST_URL = 'https://server.foxyswap.net/tokens';
export const TOKENLIST_REMOTE_URL = 'https://server.foxyswap.net/api/tokens/tokenlist';

export const FOXY_TOKENLIST_URL =
  process.env.NEXT_PUBLIC_FOXY_TOKENLIST_URL ??
  'https://api.foxyswap.net/api/v1/tokenlist.json'



export const LAUNCHPAD_TOKENLIST_URL = '/v1/launchpad/tokenlist.json';
export const LAUNCHPAD_LIST_URL = '/v1/launchpad/tokenlist.json';
export const FALLBACK_LOGO  = 'https://foxyexchange.netlify.app/placeholder.png';
export const LP_MANAGE_URL_BASE: string | null = null;
export const STORAGE_KEY = 'toshiba:customTokens:v1';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Chains that must use old shit (no EIP-1559). */
export const LEGACY_CHAINS = new Set<number>([159]);

export type RouterDef = { label: string; address: string };
export type NFTMarketCfg = {
  marketplace?: string;
  nft721Factory?: string;
  nft1155Factory?: string;
};

export type ChainConfig = {
  /** EVM chain id */
  id: number;
  /** Human label (optional) */
  name?: string;
  /** Read-only RPC */
  READ_RPC: string;
  /** Explorer roots + helpers */
  EXPLORER: string;
  EXPLORER_TX: (h: string) => string;
  EXPLORER_ADDR: (a: string) => string;
  /** UI assets */
  NATIVE_LOGO: string;
  /** Optional fixed pinned token symbols for this chain */
  PINNED_TOKENS?: string[];
  /** DEX infra */
  ROUTERS: RouterDef[];
  FACTORIES: string[];
  /** Pricing helpers */
  WETH_PRICE_API?: string;
  /** Canonical wrapped native */
  WETH: string;
  /** App contracts on this chain */
  DEFAULT_ROUTER?: string;
  DEFAULT_FACTORY?: string;
  MAIN_TREASURY_ADDR?: string;
  PERMIT2_ADDR?: string;
  DEFAULT_MC3?: string;
  DUSTER_ADDR?: string;
  SWAPPER_ADDR?: string;
  STAKING_FACTORY_ADDR?: string;
  ORDER_BOOK_ADDR?: string;
  MIGRATOR_ADDRESS?: string;
  BONDED_LAUNCH_FACTORY_ADDRESS?: string;
  AIRDROPPER_ADDR?: string;
  TOKEN_LIST_ADDR?: string;

  /** NFT market (if present for this chain) */
  NFTMARKET?: NFTMarketCfg;
};

export const CHAINS: Record<number, ChainConfig> = {

  1: {
    id: 1,
    name: 'Ethereum Mainnet',

    READ_RPC: 'https://ethereum-rpc.publicnode.com',
    EXPLORER: 'https://etherscan.io',
    EXPLORER_TX: (h: string) => `https://etherscan.io/tx/${h}`,
    EXPLORER_ADDR: (a: string) => `https://etherscan.io/address/${a}`,
    NATIVE_LOGO: 'https://assets.pancakeswap.finance/web/native/1.png',
    PINNED_TOKENS: ['ETH', 'WETH', 'USDC', 'USDT'],
    WETH_PRICE_API:
      'https://server.foxyswap.net/api/1/value?address=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2&qty=1',

    ROUTERS: [
      { label: 'uniswap', address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' },
      { label: 'pancake', address: '0xEfF92A263d31888d860bD50809A8D171709b7b1c' },
    ],
    // i put the v3v4 addys on the api directly  for faster v3v4 aggregation

    FACTORIES: [
      '0xCA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
      '0x1097053Fd2ea711dad45caCcc45EfF7548fCB362',
    ],

    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',

    DEFAULT_ROUTER: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    DEFAULT_FACTORY: '0xCA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    MAIN_TREASURY_ADDR: '0xbA0c86b77F0A4c81f736d9A7463D6dc0cb58966b',
    DEFAULT_MC3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    PERMIT2_ADDR: '0x4b54a1490EAb027911eDea75fe6e6CE8e94774E0',
    SWAPPER_ADDR: '0x2C4533b01D20db16e261Ad7eC28cDB1be9089c87',
    AIRDROPPER_ADDR: '0x8B0F00BE2545B02273A1806A2f3e1d4c586d3AA0',
    TOKEN_LIST_ADDR: '0x2A6761DD47058fE5f95560BCb423A846EFeB1bC7',
    TOKEN_LOCKER: '',

    DUSTER_ADDR: '',
    STAKING_FACTORY_ADDR: '',
    ORDER_BOOK_ADDR: '',
    MIGRATOR_ADDRESS: '',
    BONDED_LAUNCH_FACTORY_ADDRESS: '',

  },
  10: {
    id: 10,
    name: 'Optimism',

    READ_RPC: 'https://optimism-rpc.publicnode.com',
    EXPLORER: 'https://optimistic.etherscan.io',
    EXPLORER_TX: (h: string) => `https://optimistic.etherscan.io/tx/${h}`,
    EXPLORER_ADDR: (a: string) => `https://optimistic.etherscan.io/address/${a}`,

    NATIVE_LOGO: 'https://foxyswap.net/images/chainlogos/op.png',
    PINNED_TOKENS: ['ETH', 'WETH', 'USDC', 'USDT'],

    WETH_PRICE_API:
      'https://server.foxyswap.net/api/10/value?address=0x4200000000000000000000000000000000000006&qty=1',

    ROUTERS: [
      { label: 'foxyswap', address: '0x2aF2721e144CE3bC37B0fB0bD0Be04662c5A6e12' },
    ],

    FACTORIES: [
      '0x6512D8f04a5B697620f650A012619d4e1EB5a569' // uniswap v3 factory
    ],

    WETH: '0x4200000000000000000000000000000000000006',

    DEFAULT_ROUTER: '0x2aF2721e144CE3bC37B0fB0bD0Be04662c5A6e12',
    DEFAULT_FACTORY: '0x6512D8f04a5B697620f650A012619d4e1EB5a569',

    MAIN_TREASURY_ADDR: '0xbA0c86b77F0A4c81f736d9A7463D6dc0cb58966b',
    DEFAULT_MC3: '0xcA11bde05977b3631167028862bE2a173976CA11',

    PERMIT2_ADDR: '0xE5a3CD8C441261B57E1DBCFEbfd7622F28ae338F',
    SWAPPER_ADDR: '0x148aC8d8511D3dA46Bd104b95561A659c70e2EF8',
    AIRDROPPER_ADDR: '0x70fe1202B2Eb17Be8058aB518e80830E9FB57AEB',
    TOKEN_LIST_ADDR: '0x4dFA6CF25d5BB20fC3E60a640Ad7a7523Ce01906',
    TOKEN_LOCKER:    '0x591a169fd97f5e3B127D48d1DDe9f107C70E904C',

    DUSTER_ADDR: '',
    STAKING_FACTORY_ADDR: '0xa06b111B3f80e052b28a6dAFcB3DC958ff5F465F',
    ORDER_BOOK_ADDR: '',
    MIGRATOR_ADDRESS: '',
    BONDED_LAUNCH_FACTORY_ADDRESS: '',
  },

  56: {
    id: 56,
    name: 'BSC Mainnet',

    // Public RPC (swap to your preferred / paid RPC if you have one)
    READ_RPC: 'https://bsc-rpc.publicnode.com',

    EXPLORER: 'https://bscscan.com',
    EXPLORER_TX: (h: string) => `https://bscscan.com/tx/${h}`,
    EXPLORER_ADDR: (a: string) => `https://bscscan.com/address/${a}`,

    // Use whatever you host (this is just a sane default path)
    NATIVE_LOGO: 'https://tokens.pancakeswap.finance/images/symbol/bnb.png',

    PINNED_TOKENS: ['BNB', 'WBNB', 'USDC'],

    // Your own price API endpoint pattern (example uses WBNB as the “WETH”/wrapped-native anchor)
    WETH_PRICE_API:
      'https://server.foxyswap.net/api/56/value?address=0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c&qty=1',

    // Routers you want to allow / show
    ROUTERS: [
      { label: 'foxyswap',       address: '0x6e2eC98D70B190F258a5F5f2a4aaA5BaDE08aFB0' },
      { label: 'pancakeswap-v2', address: '0x10ED43C718714eb63d5aA57B78B54704E256024E' },
      // add yours:
      // { label: 'foxyswap', address: '0x...' },
      // { label: 'foxyvault1', address: '0x...' },
    ],

    // Factories you want to allow / show
    FACTORIES: [
      '0x4be6afA13A224F48E7FE48937200fe7c67f3c936',
      '0xCA143Ce32Fe78f1f7019d7d551a6402fC5350c73', // PancakeSwap V2 factory
      // add yours:
      // '0x...',
    ],

    // IMPORTANT: in your config naming, WETH is being used as “wrapped native”
    // so on BSC this should be WBNB.
    WETH: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB

    DEFAULT_ROUTER: '0x6e2eC98D70B190F258a5F5f2a4aaA5BaDE08aFB0',
    DEFAULT_FACTORY: '0x4be6afA13A224F48E7FE48937200fe7c67f3c936',

    // TODO: set these to YOUR deployed addresses on BSC
    MAIN_TREASURY_ADDR:            '0xbA0c86b77F0A4c81f736d9A7463D6dc0cb58966b',
    DEFAULT_MC3:                   '0xcA11bde05977b3631167028862bE2a173976CA11',
    SWAPPER_ADDR:                  '0x3B25af138931C6789b285Df6e0916BDAD5b344D1',
    AIRDROPPER_ADDR:               '0x3A56b57D095B6C0cCa79B27bb9CDc30F084470a3',
    TOKEN_LIST_ADDR:               '0xd3db21ad1633b2aF706Dcb49B7C3A643Ca040691',
    STAKING_FACTORY_ADDR:          '0xe109dD7Db53AeA3Ed8f3af122B1be56BF7Af08CC',
    TOKEN_LOCKER: '0xBd5298c08c5747779B2C1c891707ca0Ef4a43c04',

    DUSTER_ADDR:                   '0x0000000000000000000000000000000000000000',
    ORDER_BOOK_ADDR:               '0x0000000000000000000000000000000000000000',
    MIGRATOR_ADDRESS:              '0x0000000000000000000000000000000000000000',
    BONDED_LAUNCH_FACTORY_ADDRESS: '0x0000000000000000000000000000000000000000',

    // Permit2 (works cross-chain where deployed; this is the canonical Permit2 address)
    PERMIT2_ADDR: '0xE465b1bb6D08dA32707337C843cC528e6dbBa2A3',
  },

  137: {
    id: 137,
    name: 'Polygon PoS',
    READ_RPC: 'https://polygon-rpc.com', // public RPC :contentReference[oaicite:5]{index=5}

    EXPLORER: 'https://polygonscan.com',
    EXPLORER_TX: (h: string) => `https://polygonscan.com/tx/${h}`,
    EXPLORER_ADDR: (a: string) => `https://polygonscan.com/address/${a}`,

    // TODO: set to your preferred logo URL
    NATIVE_LOGO: 'https://foxyswap.net/images/chainlogos/polygon.webp',

    // Safe defaults; edit to your UI needs
    PINNED_TOKENS: ['POL', 'USDC', 'WETH', 'WMATIC'],

    // Your existing backend pattern — WMATIC address filled (edit if your backend expects something else)
    WETH_PRICE_API:
      'https://server.foxyswap.net/api/137/value?address=0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270&qty=1',

    // TODO: your deployed routers on Polygon
    ROUTERS: [
      { label: 'quickswap',   address: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff' },
      { label: 'sushiswap', address: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506' },
      { label: 'uniswap', address: '0xedf6066a2b290C185783862C7F4776A2C8077AD1' },
    ],

    // TODO: your deployed factories on Polygon
    FACTORIES: [
      '0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C',
        '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
          '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
    ],

    // Your app uses WETH key; on Polygon this is WMATIC
    WETH: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',

    // TODO: set once ROUTERS/FACTORIES are filled
    DEFAULT_ROUTER:  '0xedf6066a2b290C185783862C7F4776A2C8077AD1',
    DEFAULT_FACTORY: '0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C',

    // TODO: your protocol contracts on Polygon
    MAIN_TREASURY_ADDR:            '0xbA0c86b77F0A4c81f736d9A7463D6dc0cb58966b',
    SWAPPER_ADDR:                  '0xb118E93462dd88dDb51aF8e950677A51408fb114',
    AIRDROPPER_ADDR:               '0x8F839d94A09EAc66B034bC77B59F45809Cf8f06b',
    TOKEN_LIST_ADDR:               '0x88a91014AFc11533c85551379DD06F795F833CF6',
    STAKING_FACTORY_ADDR:          '0x8093d6640d7522A65764Dc0F5CaFA151C8DeFEE4',
    TOKEN_LOCKER: '',

    ORDER_BOOK_ADDR:               '0x0000000000000000000000000000000000000000',
    MIGRATOR_ADDRESS:              '0x0000000000000000000000000000000000000000',
    BONDED_LAUNCH_FACTORY_ADDRESS: '0x0000000000000000000000000000000000000000',
    DUSTER_ADDR:                   '0x0000000000000000000000000000000000000000',

    // Known shared infra
    PERMIT2_ADDR: '0x66E4847dD3fd78F5359a996ef984Fc81E3eD1925',
    DEFAULT_MC3:  '0xcA11bde05977b3631167028862bE2a173976CA11',
  },

  146: {
    id: 146,
    name: 'Sonic',
    READ_RPC: 'https://rpc.soniclabs.com/',

    // Explorer not provided in your reference — keep editable
    EXPLORER: '',
    EXPLORER_TX: (h: string) => ``,
    EXPLORER_ADDR: (a: string) => ``,

    NATIVE_LOGO: 'https://cdn.jsdelivr.net/gh/Amichain/chain-icons/svg/146.svg',

    PINNED_TOKENS: ['WETH', 'USDT', 'USDC'],

    // Price API pattern kept identical — edit address if needed
    WETH_PRICE_API:
      'https://server.foxyswap.net/api/146/value?address=0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38&qty=1',

    // ONLY using routers (per your instruction)
    ROUTERS: [
      { label: 'swapx',  address: '0xF5F7231073b3B41c04BA655e1a7438b1a7b29c27' },
    ],

    // No factory data used
    FACTORIES: [],

    // Wrapped native from your reference
    WETH: '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38',

    // Set these once you decide defaults
    DEFAULT_ROUTER: '0xF5F7231073b3B41c04BA655e1a7438b1a7b29c27',
    DEFAULT_FACTORY: '',

    // Protocol/system contracts — editable
    MAIN_TREASURY_ADDR:            '',
    DUSTER_ADDR:                   '',
    SWAPPER_ADDR:                  '',
    STAKING_FACTORY_ADDR:          '',
    ORDER_BOOK_ADDR:               '',
    MIGRATOR_ADDRESS:              '',
    BONDED_LAUNCH_FACTORY_ADDRESS: '',
    AIRDROPPER_ADDR:               '',
    TOKEN_LIST_ADDR:               '',
    TOKEN_LOCKER: '',

    // Shared infra (from your reference)
    PERMIT2_ADDR:  '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    DEFAULT_MC3:   '0xcA11bde05977b3631167028862bE2a173976CA11',
  },

  159: {
    id: 159,
    name: 'Roburna Testnet',
    READ_RPC: 'https://preseed-testnet-1.roburna.com',
    EXPLORER: 'https://testnet.rbascan.com',
    EXPLORER_TX: (h) => `https://testnet.rbascan.com/tx/${h}`,
    EXPLORER_ADDR: (a) => `https://testnet.rbascan.com/${a}`,
    NATIVE_LOGO: 'https://foxyswap.net/images/rba1.png',
    PINNED_TOKENS: ['RBAT','TFOXY','USDC','WRBAT' ],

    WETH_PRICE_API: 'https://server.foxyswap.net/api/159/value?address=0x0C6eF4f55f315C524C590572625d733491DC0921&qty=1',

    ROUTERS: [
      { label: 'arborswap', address: '0x139dEfC9CDDd77A137F8C5C8019367eA611124B5' },
      { label: 'foxyswap',  address: '0x83641dBab18AF4cd14ac23F6257f3269a5693204' },
      { label: 'foxyvault1',  address: '0xaC908547E87e7f3C74e983f806C92d3c3F44603B' },
      { label: 'btcvault',  address: '0x1f523F5b769998Ff778F061aB85766Fd87D20d30' },
      { label: 'ethvault',  address: '0x5aD3e77DFc5c18A7E21910Fe3D599774e17D0E33' },
      { label: 'xrpvault',  address: '0x59871658D3Cc3821690Bc06ea66a1c4f3a8d56B2' },
      { label: 'bnbvault',  address: '0xDE5623DB927a24313a590D22e7E4c0e00004D0c1' },
      { label: 'btcvault2',  address: '0x0F202d7DcE030fe91B8CaA641440612f212eB20d' },
      { label: 'tslavault',  address: '0x9Ce26180D8A2C77a537377C55F64aDc2A8c844EB' },
      { label: 'goldvault',  address: '0x467757e851883577Facd0525Ecc768372a04EF32' },
      { label: 'solvault',  address: '0x9499352c4C5BFD0C4275f01F719Af13A3f5C7826' },
      { label: 'silvervault',  address: '0xa15A8acD03E1BfB0487900b9f066c5173Ff91334' },
      { label: 'hypevault',  address: '0xE5Fb733135BcDE94Da8A4CaA70734e9FE0ce2606' },
      { label: 'avaxvault',  address: '0xA081C1C59E4085546FF8F23F46f30B89cdc7d7a0' },





    ],
    FACTORIES: [
                                      '0xe1D76AEF00C9f4206fb25C06448D089880661dd5',
                                      '0x96d6578747402e13C5D76e1B35D027f635AE5C37',
                                      '0xa700B46237d54E0960ED938Eb0d1e9a6B469DD28',
                                      '0x725a35159F5DA28Ede5088F5D868d83a4eebE902',
                                      '0x34062E35D6fC48FA69C2fd1C9294eB7724C42132',
                                      '0xC68B21eb8f0cFAb511caA879360b4b9269c960ba',
                                      '0xe16DDd6e2497B6E3aAA96e2455089785112B0E66',
                                      '0x19e2c6459A12cC64529d8b207c15B64ABAEBdD0E',
                                      '0x7D52D20dfba16F6e7431a693000C8173ebd4A70E',
                                      '0xb08fee76B02046AFe6c29501B6e319ABCad2B743',
                                      '0x99Ea617a5b916215F8822bbEb9270e90b9E9874C',
                                      '0xE9b2Cc95CfA12F17C9a3234cACc9e678b497DD5A',
                                      '0x9a8b10844251b263537d48bfD8810D5dfe38c894',
                                      '0xA081C1C59E4085546FF8F23F46f30B89cdc7d7a0',
    ],

    WETH:                             '0x0C6eF4f55f315C524C590572625d733491DC0921',

    DEFAULT_ROUTER:                   '0x83641dBab18AF4cd14ac23F6257f3269a5693204',
    DEFAULT_FACTORY:                  '0xe1D76AEF00C9f4206fb25C06448D089880661dd5',
    MAIN_TREASURY_ADDR:               '0xbA0c86b77F0A4c81f736d9A7463D6dc0cb58966b',
    PERMIT2_ADDR:                     '0x5b82451AAF408f3eecdA1560420C69420E7Db647',
    DEFAULT_MC3:                      '0xF00647AEfa206a578ED5aD1067Cf87EefbA8b1e2',
    DUSTER_ADDR:                      '0xc8CEe2eB1f7034b9D14c7afDF97e440CD69a3a55',
    SWAPPER_ADDR:                     '0x260b549c6263261172aA3E2Da2662E32a27d6d6e', // 0xeaD4A1507C4cEE75fc3691FA57b7f2774753482C '0xbfd637DA42C7A8C0483500140605B6e4F8e6cbBA',
    STAKING_FACTORY_ADDR:             '0xDF24635719CA1cB0ab9C497AE7fEbD2942867816',
    ORDER_BOOK_ADDR:                  '0xF7302cF68B41e64BFAfB98F24E78Bfff9Aa89E22',
    MIGRATOR_ADDRESS:                 '0x5dF41ca662EFF55d076048c31F2Cd75c1821DDB0',
    BONDED_LAUNCH_FACTORY_ADDRESS:    '0x814C793410F44A32280A2609f0B1B8eAEA98168F',
    AIRDROPPER_ADDR:                  '0xEEB011b6F4A4652f4c75C342241bF42b5c36eDCc',
    TOKEN_LIST_ADDR:                  '0x690A1819Cd690116E5369e1585d0e0b476b3259B',
    TOKEN_LOCKER:                     '0x5A99Fa341825116340e91600fD5BDec19c5686dA',

  },

  5031: {
    id: 5031,
    name: 'Somnia Mainnet',

    READ_RPC: 'https://somnia-rpc.publicnode.com',
    EXPLORER: 'https://explorer.somnia.network',
    EXPLORER_TX: (h: string) => `https://explorer.somnia.network/tx/${h}`,
    EXPLORER_ADDR: (a: string) => `https://explorer.somnia.network/address/${a}`,

    NATIVE_LOGO: 'https://foxyswap.net/images/chainlogos/somnia5031.png',
    PINNED_TOKENS: ['SOMI', 'WSOMI'],

    // If your /api/:chain/value endpoint expects a WETH-style param name, keep it.
    // Here we price wrapped SOMI (WSOMI) at qty=1.
    WETH_PRICE_API:
      'https://server.foxyswap.net/api/5031/value?address=0x046ede9564a72571df6f5e44d0405360c0f4dcab&qty=1',

    ROUTERS: [
      { label: 'somnex', address: '0x365A6CA4F0A3d5603678c8dfE3747E613751240d' },
      { label: 'foxyswap', address: '0x2ec1406C8C620e38fCFd3Ad34a9F36080Bb95FFD' },
    ],

    FACTORIES: [
      '0x4604c631823ab1dBE9811c1447c156073cF6EbFd',
        '0xaFd71143Fb155058e96527B07695D93223747ed1',
    ],

    // Wrapped SOMI (WSOMI)
    WETH: '0x046ede9564a72571df6f5e44d0405360c0f4dcab',

    DEFAULT_ROUTER: '0x2ec1406C8C620e38fCFd3Ad34a9F36080Bb95FFD',
    DEFAULT_FACTORY: '0x4604c631823ab1dBE9811c1447c156073cF6EbFd',

    MAIN_TREASURY_ADDR: '0xbA0c86b77F0A4c81f736d9A7463D6dc0cb58966b',
    DEFAULT_MC3: '0x46508bCbEa60573D66eAA7040eeFc5A074095c4e',

    PERMIT2_ADDR: '0x57518C591Eb761c83D37E1ee85dC4334Fcbf8C11',
    SWAPPER_ADDR: '0x61cd1042618E1BfBa184F67D2d0e6E1ef72bd2C5',
    AIRDROPPER_ADDR: '0x02BC73cCf37204Cca1E39aBbdc0916F338ffBdd6',
    TOKEN_LIST_ADDR: '0x4A859b2FBaE3A4Bfd36356828b0718EbDf27f5aC',
    TOKEN_LOCKER:    '0xC4552bD532Ed39Dd9ebA0bc17D34beA24E1544c6',

    DUSTER_ADDR: '',
    STAKING_FACTORY_ADDR: '0x428DBDC52B89DAbcC37c5A3F96Bf7fBEEc6A4a17',
    ORDER_BOOK_ADDR: '',
    MIGRATOR_ADDRESS: '',
    BONDED_LAUNCH_FACTORY_ADDRESS: '',
  },


  8453: {
      id: 8453,
      name: 'Base',
      READ_RPC: 'https://mainnet.base.org',
      EXPLORER: 'https://basescan.org',
      EXPLORER_TX: (h) => `https://basescan.org/tx/${h}`,
      EXPLORER_ADDR: (a) => `https://basescan.org/address/${a}`,
      NATIVE_LOGO: 'https://foxyswap.net/images/chainlogos/8453.webp',
      PINNED_TOKENS: ['ETH','USDC'],

      WETH_PRICE_API: 'https://server.foxyswap.net/api/8453/value?address=0x4200000000000000000000000000000000000006&qty=1',

      ROUTERS: [
        { label: 'foxyswap', address: '0x6d25E81605150dB5A437bB76b937c4733c7cC860' },
        { label: 'uniswap', address: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24' },
        { label: 'pancake',  address: '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb' },
        { label: 'sushiswap',  address: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891' },
        { label: 'baseswap',  address: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86' },
        { label: 'rocketswap',  address: '0x4cf76043B3f97ba06917cBd90F9e3A2AAC1B306e' },
        { label: 'synthswap',  address: '0x8734B3264Dbd22F899BCeF4E92D442d538aBefF0' },
      ],
      FACTORIES: [
                                        '0xd9570Ced40ea54C714cECb8775c7d1b98609f55A',
                                        '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
                                        '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E',
                                        '0x71524B4f93c58fcbF659783284E38825f0622859',
                                        '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
                                        '0x1B8128c3A1B7D20053D10763ff02466ca7FF99FC',
                                        '0x4bd16d59A5E1E0DB903F724aa9d721a31d7D720D',
      ],

      WETH:                             '0x4200000000000000000000000000000000000006',

      DEFAULT_ROUTER:                   '0x6d25E81605150dB5A437bB76b937c4733c7cC860',
      DEFAULT_FACTORY:                  '0xd9570Ced40ea54C714cECb8775c7d1b98609f55A',
      MAIN_TREASURY_ADDR:               '0xbA0c86b77F0A4c81f736d9A7463D6dc0cb58966b',
      PERMIT2_ADDR:                     '0xA3FB3e6CA54350dB7104c1fdDB37875cf86B82cF',
      DEFAULT_MC3:                      '0xcA11bde05977b3631167028862bE2a173976CA11',

      SWAPPER_ADDR:                     '0x34c31259a9911b64D1264d55F038151734DF628e',
      AIRDROPPER_ADDR:                  '0x5d227dD25Bb9DD16031a717fA45611d653487b1d',
      TOKEN_LIST_ADDR:                  '0xE63Cd7bfe48915905F2dc051E325Fd4Bd757aAFb',
      TOKEN_LOCKER:                     '0xC403CDD8d52f6C9aE1bB91A7959Ccc5292D46852',

      STAKING_FACTORY_ADDR:             '0x27B327315cb8EFBD671FDf82730a3bD25563aea5',
      ORDER_BOOK_ADDR:                  '',
      MIGRATOR_ADDRESS:                 '',
      BONDED_LAUNCH_FACTORY_ADDRESS:    '',
      DUSTER_ADDR:                      '',

    },

    43114: {
      id: 43114,
      name: 'Avalanche',
      READ_RPC: 'https://api.avax.network/ext/bc/C/rpc',
      EXPLORER: 'https://snowtrace.io',
      EXPLORER_TX: (h) => `https://snowtrace.io/tx/${h}`,
      EXPLORER_ADDR: (a) => `https://snowtrace.io/address/${a}`,
      NATIVE_LOGO: 'https://assets.coingecko.com/coins/images/22943/thumb/AVAX_wh_small.png?1696522240',
      PINNED_TOKENS: ['AVAX', 'USDC'],

      // WAVAX price (1 unit)
      WETH_PRICE_API:
        'https://server.foxyswap.net/api/43114/value?address=0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7&qty=1',

      ROUTERS: [
        // your deployment (fill these)

        // major AVAX routers
        { label: 'foxyswap', address: '0xD9b8c3F94B4a7E42ee75595E1AdA15362442c625' },
        { label: 'traderjoe-v1', address: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4' },
        { label: 'pangolin',     address: '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106' },
        { label: 'uniswap',      address: '0x94b75331ae8d42c1b61065089b7d48fe14aa73b7' },
        { label: 'sushiswap',    address: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506' },

        // optional: Trader Joe LB (not UniswapV2-style)
        // { label: 'traderjoe-lb', address: '0xE3Ffc583dC176575eEA7FD9dF2A7c65F7E23f4C3' },
      ],

      // Factories here should be UniswapV2-style if your code calls getPair().
      FACTORIES: [
        // your deployment (fill these)

        // major AVAX v2-style factories
        '0xF00647AEfa206a578ED5aD1067Cf87EefbA8b1e2',
        '0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10', // Trader Joe V1 factory
        '0xefa94DE7a4656D787667C749f7E1223D71E9FD88', // Pangolin factory
        '0xc35dadb65012ec5796536bd9864ed8773abc74c4', // SushiSwap v2 factory
      ],

      // Wrapped native on AVAX = WAVAX
      WETH: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',

      // set these to YOUR defaults once you deploy/choose
      DEFAULT_ROUTER:  '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      DEFAULT_FACTORY: '0xc35dadb65012ec5796536bd9864ed8773abc74c4',

      MAIN_TREASURY_ADDR: '0x51a3ae19db386ea16cea8d5452e8374f8d5ee775',

      // If you use official Uniswap Permit2 on AVAX, this is the standard address.
      // If you deploy your own Permit2, replace it.
      PERMIT2_ADDR: '0x6aa719dDEeE900E487e9a46d2Eaac7926466E882',

      // Multicall3 (commonly used “same address” deployment)
      DEFAULT_MC3: '0x732f123be30C35EDD6D82A0869720eCDE55C3758',

      // your deployed system contracts on AVAX (fill these)
      SWAPPER_ADDR:      '0xD15B10BD04c2b428B8869758701BBA5d44a332b8',
      AIRDROPPER_ADDR:   '0xD0E235058E75CD6Dd713A202Ad33556bD82d21a7',
      TOKEN_LIST_ADDR:   '0x96B05066C0DE79Db5D5D3E31e57659c5c565E5c3',
      TOKEN_LOCKER:      '0x910F657913f8becea04E8aB7022E222d448fb271',

      STAKING_FACTORY_ADDR:          '0x4E4Dbef5419FBAB5501e2Ec22DDD22B025c4F308',
      ORDER_BOOK_ADDR:              '',
      MIGRATOR_ADDRESS:             '',
      BONDED_LAUNCH_FACTORY_ADDRESS: '',
      DUSTER_ADDR:                  '',
    },


  42220: {
      id: 42220,
      name: 'Celo Mainnet',
      READ_RPC: 'https://forno.celo.org',

      EXPLORER: 'https://celoscan.io',
      EXPLORER_TX: (h: string) => `https://celoscan.io/tx/${h}`,
      EXPLORER_ADDR: (a: string) => `https://celoscan.io/address/${a}`,

      // TODO: set to your own asset (or leave blank)
      NATIVE_LOGO: 'https://foxyswap.net/images/chainlogos/celo.png',

      // Symbols only (safe defaults). Edit to your UI needs.
      PINNED_TOKENS: ['CELO', 'cUSD', 'USDC', 'WETH'],

      // Your pattern — edit the token address to your “wrapped native / price base” token on Celo.
      // If your backend expects a different query shape, change it here.
      WETH_PRICE_API:
        'https://server.foxyswap.net/api/42220/value?address=0x471EcE3750Da237f93B8E339c536989b8978a438&qty=1',

      // Fill these with YOUR deployed router addresses on Celo
      ROUTERS: [
        { label: 'foxyswap',   address: '0xa06b111B3f80e052b28a6dAFcB3DC958ff5F465F' },
          { label: 'sushiswap',   address: '0xb45e53277a7e0f1d35f2a77160e91e25507f1763' },

      ],

      // Fill with YOUR factory addresses on Celo
      FACTORIES: [
        '0x4dFA6CF25d5BB20fC3E60a640Ad7a7523Ce01906',
          '0xc35dadb65012ec5796536bd9864ed8773abc74c4',
      ],

      // Your “wrapped native” token address on Celo (if your app expects the field name WETH)
      WETH: '0x471EcE3750Da237f93B8E339c536989b8978a438',

      // Choose from above once you fill them
      DEFAULT_ROUTER:  '0xa06b111B3f80e052b28a6dAFcB3DC958ff5F465F',
      DEFAULT_FACTORY: '0x4dFA6CF25d5BB20fC3E60a640Ad7a7523Ce01906',

      // Your protocol addresses on Celo
      PERMIT2_ADDR:                  '0x6512D8f04a5B697620f650A012619d4e1EB5a569',
      DEFAULT_MC3:                   '0xcA11bde05977b3631167028862bE2a173976CA11',
      MAIN_TREASURY_ADDR:            '0xbA0c86b77F0A4c81f736d9A7463D6dc0cb58966b',
      SWAPPER_ADDR:                  '0x2aF2721e144CE3bC37B0fB0bD0Be04662c5A6e12',
      AIRDROPPER_ADDR:               '0xE5a3CD8C441261B57E1DBCFEbfd7622F28ae338F',
      TOKEN_LIST_ADDR:               '0x148aC8d8511D3dA46Bd104b95561A659c70e2EF8',
      TOKEN_LOCKER:                  '0x98c11dDfbf0C61db3f871779d061c819Dd25c3d5',


      STAKING_FACTORY_ADDR:          '0x70fe1202B2Eb17Be8058aB518e80830E9FB57AEB',
      ORDER_BOOK_ADDR:               '0x0000000000000000000000000000000000000000',
      MIGRATOR_ADDRESS:              '0x0000000000000000000000000000000000000000',
      BONDED_LAUNCH_FACTORY_ADDRESS: '0x0000000000000000000000000000000000000000',
      DUSTER_ADDR:                   '0x0000000000000000000000000000000000000000',


    },
};

export const DEFAULT_CHAIN_ID = 159;

export function getChainConfig(chainId?: number): ChainConfig {
  const id = Number(chainId || DEFAULT_CHAIN_ID);
  return CHAINS[id] ?? CHAINS[DEFAULT_CHAIN_ID];
}

export function makeReadProvider(chainId?: number) {
  const cfg = getChainConfig(chainId);
  return new JsonRpcProvider(cfg.READ_RPC);
}

export function useChain() {
  const { chainId, switchNetwork } = useAppKitNetwork();
  const cfg = React.useMemo(() => getChainConfig(chainId), [chainId]);

  const isSupported = React.useMemo(() => !!CHAINS[Number(chainId || -1)], [chainId]);
  const readProvider = React.useMemo(() => makeReadProvider(cfg.id), [cfg.id]);

  return {
    cfg,
    id: cfg.id,
    READ_RPC: cfg.READ_RPC,
    EXPLORER: cfg.EXPLORER,
    EXPLORER_TX: cfg.EXPLORER_TX,
    EXPLORER_ADDR: cfg.EXPLORER_ADDR,
    NATIVE_LOGO: cfg.NATIVE_LOGO,
    PINNED_TOKENS: cfg.PINNED_TOKENS ?? [],
    ROUTERS: cfg.ROUTERS,
    FACTORIES: cfg.FACTORIES,
    WETH: cfg.WETH,
    DEFAULT_ROUTER: cfg.DEFAULT_ROUTER,
    DEFAULT_FACTORY: cfg.DEFAULT_FACTORY,
    MAIN_TREASURY_ADDR: cfg.MAIN_TREASURY_ADDR,
    PERMIT2_ADDR: cfg.PERMIT2_ADDR,
    DEFAULT_MC3: cfg.DEFAULT_MC3,
    DUSTER_ADDR: cfg.DUSTER_ADDR,
    SWAPPER_ADDR: cfg.SWAPPER_ADDR,
    STAKING_FACTORY_ADDR: cfg.STAKING_FACTORY_ADDR,
    ORDER_BOOK_ADDR: cfg.ORDER_BOOK_ADDR,
    MIGRATOR_ADDRESS: cfg.MIGRATOR_ADDRESS,
    BONDED_LAUNCH_FACTORY_ADDRESS: cfg.BONDED_LAUNCH_FACTORY_ADDRESS,
    NFTMARKET: cfg.NFTMARKET,

    isSupported,
    switchNetwork,
    readProvider,
    LEGACY_CHAINS,
  };
}
