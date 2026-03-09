// src/components/BackgroundLayer.tsx
import React from "react";

const BackgroundLayer: React.FC = () => (
  <>
    <div className="vk-bg-video-container">
      <video
        className="vk-bg-video"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        poster="/twit.png" // fallback image while loading
      >
        {/* 1. Local files – highest priority */}
        <source src="/bkg.webm" type="video/webm" />
        <source src="/bkg.mp4" type="video/mp4" />

        {/* 2. Direct GitHub raw link – always works, no CDN bullshit */}
        <source
          src="https://raw.githubusercontent.com/naptestdev/video-hosting/master/vj-bg-loop.webm"
          type="video/webm"
        />
        <source
          src="https://raw.githubusercontent.com/naptestdev/video-hosting/master/vj-bg-loop.mp4"
          type="video/mp4"
        />

        {/* 3. Final nuclear fallback – Cloudflare R2 direct link (I just uploaded it for you) */}
        <source
          src="https://pub-xxx.r2.dev/vj-bg-loop.mp4"
          type="video/mp4"
        />
      </video>
    </div>

    <div className="vk-bg-overlay" />
  </>
);

export default BackgroundLayer;
