import React, { useEffect, useRef, useState } from 'react';

const BACKEND_BASE = 'https://spotcord-1.onrender.com';

export default function WebPlayer({ code }) {
  const playerRef = useRef(null);
  const [deviceId, setDeviceId] = useState(null);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPremium, setIsPremium] = useState(null);
  const [error, setError] = useState(null);

  // Load Spotify SDK
  useEffect(() => {
    if (window.Spotify) return;
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    document.body.appendChild(script);
    return () => document.body.removeChild(script);
  }, []);

  // Helper to get a fresh token from backend
  const fetchAccessToken = async () => {
    try {
      const resp = await fetch(`${BACKEND_BASE}/refresh?code=${encodeURIComponent(code)}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to fetch token');
      return data.access_token;
    } catch (e) {
      setError(e.message);
      return null;
    }
  };

  // Check if user is premium
  const checkPremium = async (token) => {
    try {
      const r = await fetch('https://api.spotify.com/v1/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return false;
      const d = await r.json();
      return d.product === 'premium';
    } catch (e) {
      return false;
    }
  };

  useEffect(() => {
    if (!code) return;
    let mounted = true;

    const onSpotifyWebPlaybackSDKReady = async () => {
      const token = await fetchAccessToken();
      if (!token) return;
      const premium = await checkPremium(token);
      if (!mounted) return;
      setIsPremium(premium);
      if (!premium) {
        setError('Spotify Premium is required for embedded playback.');
        return;
      }

      const player = new window.Spotify.Player({
        name: 'Spotcord Web Player',
        getOAuthToken: async (cb) => {
          const t = await fetchAccessToken();
          cb(t);
        },
      });

      playerRef.current = player;

      player.addListener('ready', ({ device_id }) => {
        setDeviceId(device_id);
        setReady(true);
        // Transfer playback to this device
        fetch('https://api.spotify.com/v1/me/player', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ device_ids: [device_id], play: false }),
        }).catch(() => {});
      });

      player.addListener('not_ready', ({ device_id }) => {
        setReady(false);
        setDeviceId(null);
      });

      player.addListener('player_state_changed', (state) => {
        if (!state) return;
        setIsPlaying(!state.paused);
      });

      player.connect();
    };

    // Wait for SDK global to be ready
    if (window.Spotify) onSpotifyWebPlaybackSDKReady();
    else window.onSpotifyWebPlaybackSDKReady = onSpotifyWebPlaybackSDKReady;

    return () => {
      mounted = false;
      if (playerRef.current) {
        playerRef.current.disconnect();
      }
    };
  }, [code]);

  const togglePlay = async () => {
    if (!playerRef.current) return;
    try {
      const state = await playerRef.current.getCurrentState();
      if (!state) {
        // nothing playing, attempt to play via API
        const token = await fetchAccessToken();
        await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
        });
        return;
      }
      await playerRef.current.togglePlay();
    } catch (e) {
      setError(e.message);
    }
  };

  if (!code) return null;

  return (
    <div className="mt-4">
      {error && <div className="text-red-400 text-sm mb-2">{error}</div>}
      {isPremium === false && <div className="text-yellow-400 text-sm mb-2">Premium required to use the web player.</div>}
      <div className="flex items-center gap-3">
        <div className="text-sm text-gray-300">Player:</div>
        <div className="text-sm text-white">{ready ? 'Connected' : 'Not connected'}</div>
        <button onClick={togglePlay} className="ml-2 bg-[#5865f2] text-white px-3 py-1 rounded">
          {isPlaying ? 'Pause' : 'Play'}
        </button>
      </div>
    </div>
  );
}
