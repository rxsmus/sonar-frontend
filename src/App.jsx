// Spotify OAuth config
const SPOTIFY_CLIENT_ID = "51dd9a50cd994a7e8e374fc2169c6f25";
const SPOTIFY_REDIRECT_URI = "https://spotcord-1.onrender.com/callback";
const SPOTIFY_SCOPES = "streaming user-read-currently-playing user-read-playback-state user-modify-playback-state user-read-private user-read-email";
// SoundCloud config
const SOUNDCLOUD_CLIENT_ID = "rKvVUO0beLONnMPQZFodTSDluZBs3TJc";
const SOUNDCLOUD_REDIRECT_URI = "https://spotcord-1.onrender.com/callback";

function getSpotifyAuthUrl() {
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    show_dialog: "true"
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

function getSoundCloudAuthUrl() {
  const params = new URLSearchParams({
    client_id: SOUNDCLOUD_CLIENT_ID,
    redirect_uri: SOUNDCLOUD_REDIRECT_URI,
    response_type: "code"
  });
  // Add a state flag so our backend knows this is a SoundCloud flow
  params.set('state', 'sc');
  return `https://secure.soundcloud.com/authorize?${params.toString()}`;
}

import React, { useState, useEffect, useRef, memo, useCallback } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { io } from 'socket.io-client';
import { MessageCircle, Music, User, Send, Heart, Play, Pause, Search as SearchIcon } from 'lucide-react';
import WebPlayer from './WebPlayer';

// Top-level stable SearchResults component. Kept out of App to avoid
// remounting during frequent parent re-renders (e.g. progress updates).
const SearchResults = memo(function SearchResults({ results, onSelect }) {
  if (!results || results.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-2 mt-2 max-h-60 overflow-y-auto pr-1"
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      style={{ overflowAnchor: 'none', WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
    >
      {results.map(r => (
        <div
          key={r.id}
          onClick={() => onSelect(r)}
          className="flex items-center gap-3 p-2 hover:bg-[#23272a] rounded cursor-pointer"
        >
          {r.albumUrl ? <img src={r.albumUrl} alt={r.title} className="w-10 h-10 rounded" /> : <div className="w-10 h-10 bg-[#23272a] rounded" />}
          <div className="text-left">
            <div className="text-sm text-white">{r.title}</div>
            <div className="text-xs text-[#72767d]">{r.artist}</div>
          </div>
        </div>
      ))}
    </div>
  );
});

const App = () => {
  const BACKEND_BASE = 'https://spotcord-1.onrender.com';
  // Force Spotify login for all users
  const [spotifyConnected, setSpotifyConnected] = useState(() => !!sessionStorage.getItem('spotify_code'));
  const [soundcloudConnected, setSoundcloudConnected] = useState(() => !!sessionStorage.getItem('soundcloud_code'));

  // SoundCloud token state (retrieved from backend /sc_refresh)
  const [soundcloudToken, setSoundcloudToken] = useState(null);
  const [soundcloudTokenExpiry, setSoundcloudTokenExpiry] = useState(null);
  const scRefreshTimerRef = useRef(null);

  useEffect(() => {
    // Read code returned in URL (after backend callback redirects to frontend)
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const scCode = params.get('sc_code');
    if (code) {
      sessionStorage.setItem('spotify_code', code);
      setSpotifyConnected(true);
      // Remove code from URL without reloading
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    if (scCode) {
      sessionStorage.setItem('soundcloud_code', scCode);
      setSoundcloudConnected(true);
      // After successful SoundCloud auth, send user into the app (Now Playing)
      // navigate to the general lobby so the UI shows the main experience
      window.history.replaceState({}, document.title, '/lobby/general');
      // Immediately fetch/refresh SoundCloud token for this code so the app can play/search with auth
      try { refreshSoundCloudToken(scCode); } catch (e) { console.warn('sc token refresh failed', e); }
      // Also remove the sc_code param from the URL (now replaced)
      // If you prefer a hard navigation instead, use: window.location.href = '/lobby/general';
    }
    // If we already have a SoundCloud code in sessionStorage, fetch token
    const existingScCode = sessionStorage.getItem('soundcloud_code');
    if (existingScCode) {
      refreshSoundCloudToken(existingScCode);
    }
    // NOTE: we intentionally don't force a redirect to the login page here.
  }, []);

  // Cleanup refresh timer on unmount
  useEffect(() => {
    return () => {
      if (scRefreshTimerRef.current) clearTimeout(scRefreshTimerRef.current);
    };
  }, []);

  // Refresh SoundCloud token (calls backend /sc_refresh which handles refresh if needed)
  async function refreshSoundCloudToken(code) {
    try {
      const r = await fetch(`${BACKEND_BASE}/sc_refresh?code=${encodeURIComponent(code)}`);
      const d = await r.json();
      if (!r.ok || !d.access_token) {
        console.warn('failed to get SoundCloud access token', d);
        // If 401, clear stored code and connected state
        if (r.status === 401) {
          sessionStorage.removeItem('soundcloud_code');
          setSoundcloudConnected(false);
        }
        return null;
      }
      setSoundcloudToken(d.access_token);
      setSoundcloudTokenExpiry(d.expires_at || null);
      // Schedule a refresh a bit before expiry (30s before)
      if (d.expires_at) {
        const msUntil = d.expires_at * 1000 - Date.now() - 30000;
        if (msUntil > 0) {
          if (scRefreshTimerRef.current) clearTimeout(scRefreshTimerRef.current);
          scRefreshTimerRef.current = setTimeout(() => refreshSoundCloudToken(code), msUntil);
        }
      }
      return d.access_token;
    } catch (err) {
      console.error('sc refresh error', err);
      return null;
    }
  }
  const [currentSong, setCurrentSong] = useState(null);
  // Mode: 'song' or 'artist'
  const [mode, setMode] = useState(() => sessionStorage.getItem('lobby_mode') || 'song');
  const [spotifyUser, setSpotifyUser] = useState(null);
  const [spotifyUserDebug, setSpotifyUserDebug] = useState(null);
  const [error, setError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  // Generate or load a random username for the current user
  const colorMap = {
    Red:   '#ef4444',
    Blue:  '#3b82f6',
    Green: '#22c55e',
    Yellow:'#eab308',
    Purple:'#a21caf',
    Orange:'#f97316',
    Pink:  '#ec4899',
    Teal:  '#14b8a6',
    Cyan:  '#06b6d4',
    Indigo:'#6366f1',
    Violet:'#8b5cf6',
    Lime:  '#84cc16',
    Amber: '#f59e42',
    Brown: '#92400e',
    Gray:  '#6b7280',
    Black: '#18181b',
    White: '#f3f4f6',
  };
  const animalEmojis = {
    Fox: '🦊', Penguin: '🐧', Wolf: '🐺', Tiger: '🐯', Bear: '🐻', Otter: '🦦', Hawk: '🦅', Lion: '🦁', Koala: '🐨', Panda: '🐼',
    Fawn: '🦌', Seal: '🦭', Moose: '🫎', Bison: '🦬', Moth: '🦋', Crab: '🦀', Marten: '🦫', Jay: '🐦', Mole: '🐹', Mink: '🦦',
    Cat: '🐱', Dog: '🐶', Rabbit: '🐰', Horse: '🐴', Eagle: '🦅', Shark: '🦈', Dolphin: '🐬', Falcon: '🦅', Swan: '🦢', Goose: '🪿'
  };
  const colors = Object.keys(colorMap);
  const animals = Object.keys(animalEmojis);
  function getRandomName() {
    const color = colors[Math.floor(Math.random() * colors.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    const number = Math.floor(Math.random() * 999) + 1;
    return `${color}-${animal}-${number}`;
  }

  // Helper to extract color and animal from username
  function parseUsername(username) {
    const [color, animal] = username.split('-');
    return { color, animal };
  }
  const [username] = useState(() => {
    const saved = sessionStorage.getItem('username');
    if (saved) return saved;
    const name = getRandomName();
    sessionStorage.setItem('username', name);
    return name;
  });
  // Real-time online users
  const [onlineUsers, setOnlineUsers] = useState([
    { id: username + '-' + Math.random().toString(36).slice(2, 8), name: username }
  ]);


  // Track songId for lobby
  const [songId, setSongId] = useState(null);
  const socketRef = useRef(null);
  const lobbyRef = useRef(null);

  // Track artist for artist mode
  const [artist, setArtist] = useState(null);

  // Search UI state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  // searchSource: 'spotify' or 'soundcloud'
  const [searchSource, setSearchSource] = useState(() => sessionStorage.getItem('search_source') || 'spotify');
  const searchInProgressRef = useRef(false);
  const [volume, setVolume] = useState(50);
  // Audio element for SoundCloud playback
  const audioRef = useRef(null);
  // SoundCloud widget refs
  const scPlayerContainerRef = useRef(null);
  const scIframeRef = useRef(null);
  const scWidgetRef = useRef(null);

  // Helper to dynamically load SoundCloud Widget script
  function loadSCWidgetScript() {
    return new Promise((resolve, reject) => {
      if (window.SC && window.SC.Widget) return resolve(window.SC);
      const existing = document.querySelector('script[data-sc-widget]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.SC));
        existing.addEventListener('error', reject);
        return;
      }
      const s = document.createElement('script');
      s.setAttribute('data-sc-widget', '1');
      s.src = 'https://w.soundcloud.com/player/api.js';
      s.async = true;
      s.onload = () => resolve(window.SC);
      s.onerror = (e) => reject(e);
      document.head.appendChild(s);
    });
  }

  const performSearch = async (q) => {
    if (!q) return;
    searchInProgressRef.current = true;
    try {
      if (searchSource === 'spotify') {
        const code = sessionStorage.getItem('spotify_code');
        if (!code) {
          setSearchResults([]);
          return;
        }
        const tokenResp = await fetch(`${BACKEND_BASE}/refresh?code=${encodeURIComponent(code)}`);
        const tokenData = await tokenResp.json();
        if (!tokenResp.ok || !tokenData.access_token) {
          console.warn('failed to get access token for search', tokenData);
          if (tokenResp.status === 401) {
            sessionStorage.clear();
            window.location.href = getSpotifyAuthUrl();
            return;
          }
          setSearchResults([]);
          return;
        }
        const token = tokenData.access_token;
        const qEnc = encodeURIComponent(q);
        const r = await fetch(`https://api.spotify.com/v1/search?q=${qEnc}&type=track&limit=15`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          console.warn('spotify search failed', await r.text());
          setSearchResults([]);
          return;
        }
        const d = await r.json();
        const items = (d.tracks && d.tracks.items) || [];
        const mapped = items.map(track => {
          const smallestAlbumImage = track.album.images.reduce((smallest, image) => {
            if (!smallest || image.height < smallest.height) return image;
            return smallest;
          }, track.album.images[0]);
          return {
            id: track.id,
            title: track.name,
            artist: track.artists && track.artists[0] && track.artists[0].name,
            uri: track.uri,
            albumUrl: smallestAlbumImage ? smallestAlbumImage.url : null,
            source: 'spotify'
          };
        });
        setSearchResults(mapped);
      } else {
        // SoundCloud search. Prefer using server-backed OAuth token if available
        const qEnc = encodeURIComponent(q);
        // Use params that surface playable tracks and enable partitioning for richer results
        const params = `q=${qEnc}&limit=15&access=playable&linked_partitioning=true`;
        let r;
        if (soundcloudToken) {
          // Authenticated search (better results, avoids client_id deprecation issues)
          r = await fetch(`https://api.soundcloud.com/tracks?${params}`, {
            headers: { Authorization: `OAuth ${soundcloudToken}` },
          });
        } else {
          // Fallback to public client_id (may be rate-limited or unsupported for some accounts)
          r = await fetch(`https://api.soundcloud.com/tracks?${params}&client_id=${SOUNDCLOUD_CLIENT_ID}`);
        }
        if (!r.ok) {
          console.warn('soundcloud search failed', await r.text());
          setSearchResults([]);
          return;
        }
        const data = await r.json();
        // The API may return either an array of tracks or an object with a `collection` array
        const items = Array.isArray(data) ? data : data.collection || [];
        const mapped = (items || []).map(track => ({
          id: track.id,
          title: track.title,
          artist: track.user && track.user.username,
          uri: track.permalink_url,
          albumUrl: track.artwork_url || null,
          source: 'soundcloud',
          permalink: track.permalink_url,
          streamable: !!track.streamable || !!track.stream_url || !!(track.media && track.media.transcodings),
          // keep stream_url and media for downstream playback logic
          stream_url: track.stream_url || null,
          media: track.media || null,
        }));
        setSearchResults(mapped);
      }
    } catch (e) {
      console.error('search failed', e);
      setSearchResults([]);
    } finally {
      searchInProgressRef.current = false;
    }
  };

  // Close search results when clicking outside the search container
  const searchContainerRef = useRef(null);
  // Controls ref: clicking these should NOT close the search results
  const controlsRef = useRef(null);
  // Use pointer/touch handlers and keyboard Escape to close; this avoids
  // clicks/wheel scroll inside the results from accidentally closing them.
  useEffect(() => {
    const onOutsidePointer = (e) => {
      const container = searchContainerRef.current;
      const controls = controlsRef.current;
      if (!container) return;
      // If the event is inside the search container or inside the player
      // controls area (play/pause/volume), don't close the results.
      if (container.contains(e.target) || (controls && controls.contains(e.target))) {
        return;
      }
      setSearchResults([]);
    };
    const onEscape = (e) => {
      if (e.key === 'Escape') setSearchResults([]);
    };
    document.addEventListener('pointerdown', onOutsidePointer);
    document.addEventListener('touchstart', onOutsidePointer);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointer);
      document.removeEventListener('touchstart', onOutsidePointer);
      document.removeEventListener('keydown', onEscape);
    };
  }, []);

  // Home / not-logged-in UI: render a simple landing when not connected
  const HomePage = () => (
    <div className="flex-1 flex items-center justify-center">
      <div className="max-w-xl text-center">
  <h1 className="text-4xl font-bold mb-4">sonar</h1>
        <p className="text-lg text-[#b9bbbe] mb-6">Connect your account to play music in-browser and match with other users listening to the same song.</p>
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={() => { window.location.href = getSpotifyAuthUrl(); }}
            className="bg-[#1DB954] hover:bg-[#17a44a] text-white px-6 py-3 rounded-lg font-semibold"
          >
            Log in to Spotify
          </button>
          <button
            onClick={() => { window.location.href = getSoundCloudAuthUrl(); }}
            className="bg-[#ff5500] hover:bg-[#e64b00] text-white px-6 py-3 rounded-lg font-semibold"
          >
            Log in to SoundCloud
          </button>
        </div>
      </div>
    </div>
  );



  // Stable callback so SearchResults doesn't re-render on every parent render.
  const handleSearchSelect = useCallback((r) => {
    (async () => {
      try {
        if (r.source === 'soundcloud') {
          // stop spotify player if running
          try { window.SonarPlayerControls?.pause?.(); } catch (e) {}

          // Cleanup existing widget/iframe if present
          try {
            if (scWidgetRef.current && scWidgetRef.current.unbind) {
              scWidgetRef.current.unbind(SC.Widget.Events.PLAY_PROGRESS);
              scWidgetRef.current.unbind(SC.Widget.Events.PLAY);
              scWidgetRef.current.unbind(SC.Widget.Events.PAUSE);
              scWidgetRef.current.unbind(SC.Widget.Events.FINISH);
            }
          } catch (e) {}
          if (scIframeRef.current) {
            try { scIframeRef.current.remove(); } catch (e) {}
            scIframeRef.current = null;
            scWidgetRef.current = null;
          }

          // Ensure widget script is loaded and then create an iframe player via the Widget API
          try {
            await loadSCWidgetScript();
            const trackApiUrl = encodeURIComponent(`https://api.soundcloud.com/tracks/${r.id}`);
            const params = `auto_play=true&show_artwork=false&visual=false`;
            const iframeSrc = `https://w.soundcloud.com/player/?url=${trackApiUrl}&${params}`;

            const iframe = document.createElement('iframe');
            iframe.width = '100%';
            iframe.height = '1';
            iframe.style.display = 'none';
            iframe.allow = 'autoplay';
            iframe.src = iframeSrc;
            // Insert into the container
            const container = scPlayerContainerRef.current || document.body;
            container.appendChild(iframe);
            scIframeRef.current = iframe;

            // Create widget and bind events
            const widget = window.SC.Widget(iframe);
            scWidgetRef.current = widget;

            widget.bind(window.SC.Widget.Events.READY, () => {
              try {
                // set initial volume to current slider
                widget.setVolume(Math.round(volume));
                widget.play();
              } catch (e) {}
            });
            widget.bind(window.SC.Widget.Events.PLAY_PROGRESS, (progress) => {
              // progress.currentPosition is milliseconds, relativePosition in [0,1]
              setCurrentSong(prev => ({ ...(prev || {}), progress: progress.currentPosition || 0, duration: progress.duration || prev?.duration || 0 }));
            });
            widget.bind(window.SC.Widget.Events.PLAY, () => setCurrentSong(prev => ({ ...(prev || {}), isPlaying: true, source: 'soundcloud' })));
            widget.bind(window.SC.Widget.Events.PAUSE, () => setCurrentSong(prev => ({ ...(prev || {}), isPlaying: false })));
            widget.bind(window.SC.Widget.Events.FINISH, () => setCurrentSong(prev => ({ ...(prev || {}), isPlaying: false, progress: prev?.duration || 0 })));

            setCurrentSong({ title: r.title, artist: r.artist, album: '', duration: 0, progress: 0, albumArt: r.albumUrl, isPlaying: true, source: 'soundcloud', permalink: r.permalink });
          } catch (e) {
            console.warn('SC widget creation/play failed', e);
            // Last resort: open the permalink
            window.open(r.permalink, '_blank');
            setCurrentSong(prev => ({ ...(prev || {}), isPlaying: false }));
          }
        } else {
          window.SonarPlayerControls?.playUri?.(r.uri);
          setCurrentSong(prev => ({ ...(prev || {}), isPlaying: true, source: 'spotify' }));
        }
      } catch (e) {
        console.error('playUri failed', e);
      } finally {
        setSearchResults([]);
        setSearchQuery('');
      }
    })();
  }, []);

  // Fetch from Flask backend and set songId/artist
  useEffect(() => {
    // replace polling with SDK event listener
    const handleState = (e) => {
      const data = e.detail;
      if (!data || !data.track_id) {
        setCurrentSong(null);
        setSongId(null);
        setArtist(null);
        return;
      }
      setCurrentSong({
        title: data.track_name,
        artist: data.artists,
        album: data.album_name,
        duration: data.duration,
        progress: data.position,
        albumArt: data.album_image_url,
        isPlaying: data.isPlaying,
      });
      setSongId(data.track_id);
      if (data.artists) setArtist(data.artists.split(',')[0].trim());
    };

  window.addEventListener('sonar_player_state', handleState);
  return () => window.removeEventListener('sonar_player_state', handleState);
  }, []);



  // Update URL to /lobby/<track_id> or /lobby/<artist> or /lobby/general based on mode
  useEffect(() => {
    let newPath = '/lobby/general';
    if (mode === 'artist' && artist) {
      newPath = `/lobby/${encodeURIComponent(artist)}`;
    } else if (mode === 'song' && songId) {
      newPath = `/lobby/${songId}`;
    }
    if (window.location.pathname !== newPath) {
      window.history.replaceState({}, '', newPath);
    }
  }, [mode, songId, artist]);


  // Connect to socket.io namespace for this songId or general


  useEffect(() => {
    let lobby = 'general';
    if (mode === 'artist' && artist) {
      lobby = encodeURIComponent(artist);
    } else if (mode === 'song' && songId) {
      lobby = songId;
    }
    if (lobbyRef.current === lobby && socketRef.current) {
      // Already connected to correct lobby, do nothing
      return;
    }
    // Disconnect previous socket if exists
    if (socketRef.current) {
      socketRef.current.disconnect();
    }
    // Connect to new lobby
  const socket = io(`https://spotcord.onrender.com/lobby/${lobby}`);
    socketRef.current = socket;
    lobbyRef.current = lobby;
    setMessages([]); // Clear chat when switching lobbies
    socket.emit('join', { username, songId, artist });
    socket.on('online-users', (users) => {
      setOnlineUsers(users.map(name => ({
        id: name + '-' + Math.random().toString(36).slice(2, 8),
        name
      })));
    });
    socket.on('chat-history', (history) => {
      setMessages(history);
    });
    socket.on('new-message', (msg) => {
      setMessages(prev => [...prev, msg]);
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
      lobbyRef.current = null;
    };
  }, [username, songId, artist, mode]);




  const handleSendMessage = () => {
    if (!newMessage.trim() || !socketRef.current) return;
    const msg = {
      user: username,
      avatar: "https://placehold.co/40x40/1db954/ffffff?text=U",
      message: newMessage,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    socketRef.current.emit('send-message', msg);
    setNewMessage("");
  };


  // Like functionality removed

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') handleSendMessage();
  };

  // Render app if either Spotify OR SoundCloud is connected
  if (!spotifyConnected && !soundcloudConnected) {
    return (
      <div className="fixed inset-0 w-screen h-screen bg-black text-gray-100 overflow-hidden flex">
        <main className="flex-1 h-full px-8 py-8 flex items-center">
          <HomePage />
        </main>
        <Analytics />
      </div>
    );
  }

  return (
  <div className="fixed inset-0 w-screen h-screen bg-black text-gray-100 overflow-hidden flex">
    {/* Sidebar */}
  <aside className="w-28 min-w-24 h-full flex flex-col bg-[#18191a] border-r border-[#23272a] shadow-lg p-3 gap-4 justify-between">
      <div className="flex flex-col items-center gap-4">
        {spotifyUser && (
          <span className="text-xs text-[#43b581] text-center">{spotifyUser}</span>
        )}
        {/* Login / Connected button */}
        <div>
          {!spotifyConnected ? (
            <button
              onClick={() => { window.location.href = getSpotifyAuthUrl(); }}
              className="bg-[#1DB954] text-white px-3 py-2 rounded-lg text-xs font-semibold"
            >
              Log in to Spotify
            </button>
          ) : (
            <button className="bg-[#2f3136] text-[#43b581] px-3 py-2 rounded-lg text-xs font-semibold" disabled>
              Connected to Spotify
            </button>
          )}
        </div>
        <div>
          {soundcloudConnected ? (
            <div className="text-xs text-[#ff5500] mt-1">Connected to SoundCloud</div>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 w-full mt-2">
          <div className="flex flex-col bg-[#23272a] rounded-2xl p-1 w-full">
            <button
              className={`w-full px-2 py-2 rounded-t-xl text-xs font-semibold focus:outline-none transition-colors duration-150 ${mode === 'artist' ? 'bg-[#43b581] text-white' : 'bg-transparent text-gray-400'}`}
              onClick={() => {
                setMode('artist');
                sessionStorage.setItem('lobby_mode', 'artist');
              }}
            >Artist</button>
            <button
              className={`w-full px-2 py-2 rounded-b-xl text-xs font-semibold focus:outline-none transition-colors duration-150 ${mode === 'song' ? 'bg-[#43b581] text-white' : 'bg-transparent text-gray-400'}`}
              onClick={() => {
                setMode('song');
                sessionStorage.setItem('lobby_mode', 'song');
              }}
            >Song</button>
          </div>
          {/* Web Playback SDK player moved to bottom fixed bar */}
          <div className="flex items-center justify-center gap-1 bg-[#23272a] rounded-lg px-2 py-1 text-gray-300 text-xs shadow border border-[#36393f] w-full">
            <User className="w-4 h-4" />
            <span>{onlineUsers.length}</span>
          </div>
        </div>
      </div>
      <button
        className="w-14 h-14 bg-[#ed4245] text-white rounded-2xl flex items-center justify-center hover:bg-[#b3242a] transition self-center mb-2"
        title="Log out"
        onClick={() => {
          sessionStorage.clear();
          setSpotifyConnected(false);
          // stay on the app home after logout
          window.location.href = '/';
        }}
        aria-label="Log out"
      >
        <img src="/icons/logout-svgrepo-com.svg" alt="Log out" className="w-8 h-8 filter brightness-0 invert" />
        <span className="sr-only">Log out</span>
      </button>
    </aside>

  <main className="flex-1 h-full px-8 py-8 flex flex-col lg:flex-row gap-8">
          {/* Current Song Section */}
        {/* Main Content (Current Song + Chat) */}
        <section className="flex-1 flex flex-col gap-6">
          <div className="bg-black rounded-2xl p-6 shadow-lg border border-[#36393f]">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-[#b9bbbe]">
              <Music className="w-5 h-5 text-[#5865f2]" />
              Now Playing
            </h2>
            {/* Debug output removed as requested */}
            {error ? (
              <p className="text-red-400">{error}</p>
            ) : !currentSong ? (
              <p className="text-gray-500">No track is currently playing.</p>
            ) : (
              <div className="flex flex-col md:flex-row items-center gap-6">
                <div>
                  <img
                    src={currentSong.albumArt}
                    alt={currentSong.album}
                    className="w-44 h-44 rounded-xl shadow-md border border-[#23272a]"
                  />
                </div>
                <div className="flex-1 text-center md:text-left">
                  <h3 className="text-2xl font-bold mb-1 text-white">{currentSong.title}</h3>
                  <p className="text-lg text-[#b9bbbe] mb-1">{currentSong.artist}</p>
                  <p className="text-md text-[#72767d] mb-4">{currentSong.album}</p>
                  {/* Minimal song progress bar */}
                  {currentSong && currentSong.duration > 0 && (
                    <div className="w-full bg-[#1f2123] rounded h-1 mt-2 overflow-hidden">
                      <div
                        className="h-1 bg-[#5865f2]"
                        style={{ width: `${Math.min(100, Math.max(0, ((currentSong.progress || 0) / currentSong.duration) * 100))}%` }}
                      />
                    </div>
                  )}
                  {/* Player controls moved to bottom bar */}
                </div>
              </div>
            )}
          </div>
          {/* Chat Section */}
          <div className="flex-1 flex flex-col bg-black rounded-2xl shadow-lg border border-[#36393f] min-h-0">
            <div className="px-6 py-4 border-b border-[#36393f] bg-black rounded-t-2xl">
              <h3 className="text-lg font-semibold flex items-center gap-2 text-[#b9bbbe]">
                <MessageCircle className="w-5 h-5" />
                Chat
              </h3>
              <p className="text-xs text-[#72767d] mt-1">{onlineUsers.length} online</p>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4 bg-black">
              {messages.map(msg => {
                const { color, animal } = parseUsername(msg.user);
                return (
                  <div key={msg.id} className="flex items-start gap-3">
                    <div
                      className="w-10 h-10 rounded-full border border-[#23272a] flex items-center justify-center text-2xl"
                      style={{ backgroundColor: colorMap[color] || '#23272a' }}
                    >
                      {animalEmojis[animal] || '❓'}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-sm text-white">{msg.user}</span>
                        <span className="text-[#72767d] text-xs">{msg.timestamp}</span>
                      </div>
                      <p className="text-[#dcddde] text-sm mb-2">{msg.message}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-[#36393f] p-4 flex gap-3 bg-black rounded-b-2xl">
              <input
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Type your message..."
                  className="flex-1 bg-black border border-[#23272a] rounded-lg px-4 py-3 text-white placeholder-[#72767d] focus:outline-none focus:ring-2 focus:ring-[#5865f2]"
                />
              <button
                onClick={handleSendMessage}
                className="bg-[#5865f2] hover:bg-[#4752c4] rounded-lg p-3 transition-all shadow text-white"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
        </section>

        {/* Sidebar (right column) */}
        <aside className="w-full lg:w-64 flex-shrink-0 flex flex-col gap-6">
          <div className="bg-black rounded-2xl p-6 shadow-lg border border-[#36393f]">
            <h3 className="text-md font-semibold mb-4 flex items-center gap-2 text-[#b9bbbe]">
              <div className="w-3 h-3 bg-[#43b581] rounded-full mr-2"></div>
              Online Users
            </h3>
            <div className="flex flex-col gap-2">
              {onlineUsers.map(u => {
                const { color, animal } = parseUsername(u.name);
                return (
                  <div key={u.id} className="flex items-center gap-3 p-2 hover:bg-[#23272a] rounded-lg transition-colors">
                    <div
                      className="w-8 h-8 rounded-full border border-[#23272a] flex items-center justify-center text-xl"
                      style={{ backgroundColor: colorMap[color] || '#23272a' }}
                    >
                      {animalEmojis[animal] || '❓'}
                    </div>
                    <span className="text-sm text-white">{u.name}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Separate Player card */}
          <div className="bg-black rounded-2xl p-4 shadow-lg border border-[#36393f]">
            <div ref={searchContainerRef}>
              {/* Provider toggle above the search bar */}
              <div className="mb-3 flex items-center gap-2">
                <button
                  onClick={() => { setSearchSource('spotify'); sessionStorage.setItem('search_source', 'spotify'); }}
                  className={`px-3 py-2 rounded text-sm font-medium ${searchSource === 'spotify' ? 'bg-[#1DB954] text-black' : 'bg-transparent text-gray-400 border border-[#1f2123]'}`}
                >Spotify</button>
                <button
                  onClick={() => { setSearchSource('soundcloud'); sessionStorage.setItem('search_source', 'soundcloud'); }}
                  className={`px-3 py-2 rounded text-sm font-medium ${searchSource === 'soundcloud' ? 'bg-[#ff5500] text-black' : 'bg-transparent text-gray-400 border border-[#1f2123]'}`}
                >SoundCloud</button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') performSearch(searchQuery); }}
                  placeholder={searchSource === 'spotify' ? 'Search Spotify...' : 'Search SoundCloud...'}
                  className="flex-1 bg-transparent border border-[#1f2123] rounded px-3 py-2 text-sm text-white focus:outline-none"
                />
                <button
                  onClick={(e) => { e.stopPropagation(); performSearch(searchQuery); }}
                  className="bg-[#5865f2] hover:bg-[#4752c4] text-white p-2 rounded"
                  aria-label="Search"
                >
                  <SearchIcon className="w-4 h-4" />
                </button>
              </div>
              <div className="mt-3">
                <SearchResults results={searchResults} onSelect={handleSearchSelect} />
              </div>
            </div>
            <div ref={controlsRef} className="mt-4 flex items-center justify-center gap-3">
              <button
                onClick={() => {
                  if (currentSong && currentSong.source === 'soundcloud') {
                    try { audioRef.current && audioRef.current.play(); } catch (e) { console.warn(e); }
                  } else {
                    window.SonarPlayerControls?.play?.();
                  }
                }}
                title="Play"
                className="bg-[#43b581] hover:bg-[#369e67] p-2 rounded-lg"
                aria-label="Play"
              >
                <Play className="w-4 h-4 text-white" />
              </button>
              <button
                onClick={() => {
                  if (currentSong && currentSong.source === 'soundcloud') {
                    try { audioRef.current && audioRef.current.pause(); } catch (e) { console.warn(e); }
                  } else {
                    window.SonarPlayerControls?.pause?.();
                  }
                }}
                title="Pause"
                className="bg-[#5865f2] hover:bg-[#4752c4] p-2 rounded-lg"
                aria-label="Pause"
              >
                <Pause className="w-4 h-4 text-white" />
              </button>
              <div className="flex items-center gap-2 ml-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={volume}
                  onChange={async (e) => {
                    const v = Number(e.target.value);
                    setVolume(v);
                    try {
                      if (currentSong && currentSong.source === 'soundcloud') {
                        try {
                          if (scWidgetRef.current && scWidgetRef.current.setVolume) {
                            scWidgetRef.current.setVolume(Math.round(v));
                          } else if (audioRef.current) {
                            audioRef.current.volume = v / 100;
                          }
                        } catch (e) { console.warn('set volume failed', e); }
                        return;
                      }
                      const code = sessionStorage.getItem('spotify_code');
                      if (!code) return;
                      const tokenResp = await fetch(`${BACKEND_BASE}/refresh?code=${encodeURIComponent(code)}`);
                      const tokenData = await tokenResp.json();
                      if (!tokenResp.ok || !tokenData.access_token) return;
                      const token = tokenData.access_token;
                      const id = (window.SonarPlayerControls && window.SonarPlayerControls._deviceId) || null;
                      // Use deviceId from our WebPlayer if available, otherwise omit device_id so Spotify uses the active device
                      const url = id ? `https://api.spotify.com/v1/me/player/volume?device_id=${id}&volume_percent=${v}` : `https://api.spotify.com/v1/me/player/volume?volume_percent=${v}`;
                      await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
                    } catch (err) {
                      console.error('volume set error', err);
                    }
                  }}
                  className="w-24 h-1 rounded"
                  aria-label="Volume"
                  style={{
                    background: `linear-gradient(to right, #5865f2 ${volume}%, #1f2123 ${volume}%)`,
                    WebkitAppearance: 'none',
                    appearance: 'none'
                  }}
                />
              </div>
            </div>
          </div>
          {/* Hidden audio element used as fallback for SoundCloud streaming */}
          <audio ref={audioRef} style={{ display: 'none' }} />
          {/* Container for SoundCloud iframe widget (invisible) */}
          <div ref={scPlayerContainerRef} style={{ display: 'none' }} />

          <div className="hidden">
            <WebPlayer code={sessionStorage.getItem('spotify_code')} showUI={false} />
          </div>
        </aside>
      </main>
      <Analytics />
  </div>
  );
};

export default App;