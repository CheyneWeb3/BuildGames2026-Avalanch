// src/App.tsx
import React, { useEffect } from "react";
import { Routes, Route, useLocation, useNavigate } from "react-router-dom";

import { useAppKit, useAppKitNetwork } from "@reown/appkit/react";

import BlackjackPage from "./pages/games/BlackjackPage";
import DiceBrowserPage from "./pages/games/DiceBrowserPage";





import VaultAdminPage from "./pages/mvp/VaultAdminPage";
import CoreApiAdminPage from "./pages/mvp/CoreApiAdminPage";
import UserWalletPage from "./pages/mvp/UserWalletPage";

import BalancesWalletPage from "./pages/mvp/BalancesWalletPage";
import TgMiniWalletPage from "./pages/mvp/TgMiniWalletPage";


import TgRegisterPage from "./pages/mvp/TgRegisterPage";

import AccountingBucketsPage from "./pages/mvp/AccountingBucketsPage";

import GoogleWalletLinkPage from "./pages/mvp/GoogleWalletLinkPage";

import DiceGooglePlayPage from "./pages/games/DiceGooglePlayPage";

import EasyRegisterPage from "./pages/mvp/EasyRegisterPage";

declare global {
  interface Window {
    Telegram?: any;
  }
}

const NetworkModalAutoClose: React.FC = () => {
  const { close } = useAppKit();
  const { chainId } = useAppKitNetwork();

  useEffect(() => {
    if (chainId != null) close();
  }, [chainId, close]);

  return null;
};

const TelegramStartParamRouter: React.FC = () => {
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    const sp = String(window.Telegram?.WebApp?.initDataUnsafe?.start_param || "").trim().toLowerCase();
    if (!sp) return;

    const map: Record<string, string> = {
      cashier: "/miniapp",
      miniapp: "/miniapp",
      blackjack: "/games/blackjack",
      bj: "/games/blackjack",
    };

    const target = map[sp];
    if (!target) return;
    if (loc.pathname === target) return;

    nav(target, { replace: true });
  }, []);

  return null;
};

const QueryParamEntryRouter: React.FC = () => {
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const r = String(u.searchParams.get("r") || "").trim();
      if (!r) return;

      const target = r.startsWith("/") ? r : `/${r}`;
      if (loc.pathname === target) return;
      nav(target, { replace: true });
    } catch {
    }
  }, []);

  return null;
};

const NonHashPathFixer: React.FC = () => {
  useEffect(() => {
    try {
      const { pathname, search, hash } = window.location;
      if (hash && hash.startsWith("#/")) return;
      const allowed = new Set(["/admin-approve", "/miniapp", "/games/blackjack", "/home", "/register"]);
      if (!allowed.has(pathname)) return;
      window.location.replace(`${window.location.origin}/#${pathname}${search || ""}`);
    } catch {
    }
  }, []);

  return null;
};

const isTelegramWebApp = () => !!window.Telegram?.WebApp;



const App: React.FC = () => {
  return (
    <>
      <NetworkModalAutoClose />
      <TelegramStartParamRouter />
      <QueryParamEntryRouter />
      <NonHashPathFixer />

      <div className="min-h-screen flex flex-col bg-transparent text-slate-50">
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<BalancesWalletPage />} />
              <Route path="/home" element={<BalancesWalletPage />} />

            <Route path="/miniapp" element={<TgMiniWalletPage />} />
            <Route path="/treasury" element={<AccountingBucketsPage />} />

            <Route path="/dice" element={<DiceBrowserPage />} />

            <Route path="/vaultadminpanel" element={<VaultAdminPage />} />
            <Route path="/coreapiadmin" element={<CoreApiAdminPage />} />
            <Route path="/user" element={<UserWalletPage />} />
            <Route path="/tg/register" element={<TgRegisterPage />} />
            <Route path="/google-link" element={<GoogleWalletLinkPage />} />

            <Route path="/googledice" element={<DiceGooglePlayPage />} />

            <Route path="/bj" element={<BlackjackPage />} />

            <Route path="/register-wallet-google" element={<EasyRegisterPage />} />


          </Routes>
        </main>
      </div>
    </>
  );
};

export default App;
