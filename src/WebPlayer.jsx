import React, { useEffect, useRef, useState } from 'react';

const BACKEND_BASE = 'https://spotcord-1.onrender.com';

export default function WebPlayer({ code, showUI = false }) {
  const playerRef = useRef(null);
  const deviceRef = useRef(null);
  const [deviceId, setDeviceId] = useState(null);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPremium, setIsPremium] = useState(null);
  const [error, setError] = useState(null);
  const [tokenScope, setTokenScope] = useState(null);

  // We'll load the Spotify SDK from inside the main effect so we can
  // register the global `onSpotifyWebPlaybackSDKReady` handler before the
  // script executes (avoids race where the SDK expects the handler to exist).

  // Helper to get a fresh token from backend
  const fetchAccessToken = async () => {
    try {
      const resp = await fetch(`${BACKEND_BASE}/refresh?code=${encodeURIComponent(code)}`);
      const data = await resp.json();
      if (!resp.ok) {
        // If the backend reports unauthorized for this code, force a re-login
        if (resp.status === 401) {
          sessionStorage.clear();
          window.location.href = `${window.location.origin}${window.location.pathname}?code=`; // trigger redirect logic
        }
        throw new Error(data.error || 'Failed to fetch token');
      }
      // store scope for diagnostics
      if (data.scope) setTokenScope(data.scope);
      // warn if streaming scope is missing since the SDK requires it
      if (data.scope && !data.scope.split(' ').includes('streaming')) {
        console.warn('Access token missing streaming scope:', data.scope);
        setError('Access token is missing the `streaming` scope. Re-authorize to enable in-browser playback.');
      }
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
    let readyTimeout = null;

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
        deviceRef.current = device_id;
        setReady(true);
        // Transfer playback to this device
        (async () => {
          try {
            const r = await fetch('https://api.spotify.com/v1/me/player', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ device_ids: [device_id], play: false }),
            });
            if (!r.ok) {
              const text = await r.text().catch(() => '[no body]');
              console.error('Failed to transfer playback to SDK device', r.status, text);
              setError('Failed to transfer playback to the Web Playback SDK device. Check token scopes and that your account is Premium.');
            }
          } catch (err) {
            console.error('Error transferring playback to device', err);
            setError(err.message || String(err));
          }
        })();
      });

      player.addListener('not_ready', ({ device_id }) => {
        setReady(false);
        setDeviceId(null);
      });

      player.addListener('player_state_changed', (state) => {
        if (!state) return;
        setIsPlaying(!state.paused);
        try {
          const track = state.track_window && state.track_window.current_track;
          const detail = {
            isPlaying: !state.paused,
            position: state.position,
            duration: state.duration,
            track_id: track ? track.id : null,
            track_name: track ? track.name : null,
            artists: track ? track.artists.map(a => a.name).join(', ') : null,
            album_name: track && track.album ? track.album.name : null,
            album_image_url: track && track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : null,
          };
          // Broadcast SDK state to the app
          window.dispatchEvent(new CustomEvent('spotcord_player_state', { detail }));
        } catch (e) {
          console.warn('Error processing player_state_changed', e);
        }
      });

      player.connect();
      // Start a short poll to read the player's current state frequently.
      // Some SDKs emit player_state_changed infrequently; polling getCurrentState
      // gives us smooth/near-real-time progress updates without manual increments.
      const pollIntervalMs = 250;
      const pollId = setInterval(async () => {
        try {
          const state = await player.getCurrentState();
          if (!state) return;
          const track = state.track_window && state.track_window.current_track;
          const detail = {
            isPlaying: !state.paused,
            position: state.position,
            duration: state.duration,
            track_id: track ? track.id : null,
            track_name: track ? track.name : null,
            artists: track ? track.artists.map(a => a.name).join(', ') : null,
            album_name: track && track.album ? track.album.name : null,
            album_image_url: track && track.album && track.album.images && track.album.images[0] ? track.album.images[0].url : null,
          };
          window.dispatchEvent(new CustomEvent('spotcord_player_state', { detail }));
        } catch (e) {
          // ignore transient errors
        }
      }, pollIntervalMs);
      // Save poll id so cleanup can clear it; attach to playerRef for access in cleanup
      playerRef.current._pollId = pollId;
      // If the player doesn't become ready within 12s, surface an error
      readyTimeout = setTimeout(() => {
        if (!deviceRef.current) {
          setError('Web Playback SDK did not become ready — check that your app origin and redirect URI are registered in the Spotify Developer dashboard and that the account is Premium.');
        }
      }, 12000);
      // Expose controls to the window so parent UI can call them
      // Helper to play a specific Spotify URI on the current device
      const playUri = async (uri) => {
        try {
          const token = await fetchAccessToken();
          const id = deviceRef.current || deviceId;
          if (!id) throw new Error('No device id');
          await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris: [uri] }),
          });
        } catch (e) {
          console.error('playUri error', e);
          setError(e.message);
        }
      };

      // Helper to search Spotify and play the first track from the results
      const searchAndPlay = async (query) => {
        try {
          const token = await fetchAccessToken();
          const q = encodeURIComponent(query);
          const r = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=5`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!r.ok) throw new Error('Search failed');
          const d = await r.json();
          const track = d.tracks && d.tracks.items && d.tracks.items[0];
          if (!track) throw new Error('No track found');
          await playUri(track.uri);
        } catch (e) {
          console.error('searchAndPlay error', e);
          setError(e.message);
        }
      };

      // Search and return track results (useful for showing a results list in the UI)
      const search = async (query) => {
        try {
          const token = await fetchAccessToken();
          const q = encodeURIComponent(query);
          const r = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=8`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!r.ok) throw new Error('Search failed');
          const d = await r.json();
          const items = (d.tracks && d.tracks.items) || [];
          return items.map(t => ({
            id: t.id,
            name: t.name,
            artists: t.artists.map(a => a.name).join(', '),
            album: t.album && t.album.name,
            album_image: t.album && t.album.images && t.album.images[0] ? t.album.images[0].url : null,
            uri: t.uri,
          }));
        } catch (e) {
          console.error('search error', e);
          setError(e.message);
          return [];
        }
      };

      // window.deviceRef is already a useRef defined above; ensure it's set by
      // the ready listener. Expose control functions using that ref.
      window.SpotcordPlayerControls = {
        play: async () => {
          try {
            // Prefer to use the SDK player directly when available
            if (playerRef.current && typeof playerRef.current.getCurrentState === 'function') {
              try {
                const state = await playerRef.current.getCurrentState();
                // If we have state and it's paused, togglePlay to resume
                if (state && state.paused) {
                  if (typeof playerRef.current.togglePlay === 'function') {
                    await playerRef.current.togglePlay();
                    return;
                  }
                }
              } catch (err) {
                // ignore and fallback to API
                console.warn('SDK play fallback, getCurrentState error', err);
              }
            }

            // Fallback to Web API play endpoint
            const token = await fetchAccessToken();
            const id = deviceRef.current || deviceId;
            if (!id) throw new Error('No device id');
            await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${id}`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch (e) {
            console.error('play error', e);
            setError(e.message);
          }
        },
        pause: async () => {
          try {
            // Prefer to use the SDK player directly when available
            if (playerRef.current && typeof playerRef.current.getCurrentState === 'function') {
              try {
                const state = await playerRef.current.getCurrentState();
                // If we have state and it's playing, togglePlay to pause
                if (state && !state.paused) {
                  if (typeof playerRef.current.togglePlay === 'function') {
                    await playerRef.current.togglePlay();
                    return;
                  }
                }
              } catch (err) {
                // ignore and fallback to API
                console.warn('SDK pause fallback, getCurrentState error', err);
              }
            }

            // Fallback to Web API pause endpoint
            const token = await fetchAccessToken();
            const id = deviceRef.current || deviceId;
            if (!id) throw new Error('No device id');
            await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${id}`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch (e) {
            console.error('pause error', e);
            setError(e.message);
          }
        },
        next: async () => {
          try {
            const token = await fetchAccessToken();
            const id = deviceRef.current || deviceId;
            if (!id) throw new Error('No device id');
            await fetch(`https://api.spotify.com/v1/me/player/next?device_id=${id}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch (e) {
            console.error('next error', e);
            setError(e.message);
          }
        },
        previous: async () => {
          try {
            const token = await fetchAccessToken();
            const id = deviceRef.current || deviceId;
            if (!id) throw new Error('No device id');
            await fetch(`https://api.spotify.com/v1/me/player/previous?device_id=${id}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch (e) {
            console.error('previous error', e);
            setError(e.message);
          }
        },
        playUri,
        searchAndPlay,
        search,
      };
    };

    // Wait for SDK global to be ready. Register the global handler BEFORE
    // appending the script so the SDK can call it immediately when it runs.
    window.onSpotifyWebPlaybackSDKReady = onSpotifyWebPlaybackSDKReady;
    if (window.Spotify) {
      // SDK already present (dev/live reload), call handler now
      onSpotifyWebPlaybackSDKReady();
    } else {
      // Append the SDK script (only once)
      if (!document.querySelector('script[src="https://sdk.scdn.co/spotify-player.js"]')) {
        const script = document.createElement('script');
        script.src = 'https://sdk.scdn.co/spotify-player.js';
        script.async = true;
        document.body.appendChild(script);
      }
    }

    return () => {
      mounted = false;
      if (playerRef.current) {
        try {
          if (playerRef.current._pollId) {
            clearInterval(playerRef.current._pollId);
            playerRef.current._pollId = null;
          }
        } catch (e) {}
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

  // If developer wants UI, render minimal status + button; otherwise no UI (we dispatch events)
  if (!showUI) return null;

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
