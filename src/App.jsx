// Spotify OAuth config
const SPOTIFY_CLIENT_ID = "51dd9a50cd994a7e8e374fc2169c6f25";
const SPOTIFY_REDIRECT_URI = "https://spotcord-1.onrender.com/callback";
const SPOTIFY_SCOPES = "streaming user-read-currently-playing user-read-playback-state user-modify-playback-state user-read-private";

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

import React, { useState, useEffect, useRef } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { io } from 'socket.io-client';
import { MessageCircle, Music, User, Send, Heart, Play, Pause } from 'lucide-react';
import WebPlayer from './WebPlayer';

const App = () => {
  // Force Spotify login for all users
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
      sessionStorage.setItem('spotify_code', code);
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (!sessionStorage.getItem('spotify_code')) {
      window.location.href = getSpotifyAuthUrl();
    }
  }, []);
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

  // Fetch from Flask backend and set songId/artist
  useEffect(() => {
    const fetchNowPlaying = async () => {
      try {
        setError(null);
        const code = sessionStorage.getItem('spotify_code');
        if (!code) {
          setError('No Spotify code found. Please log in.');
          setCurrentSong(null);
          setSongId(null);
          setSpotifyUser(null);
          setSpotifyUserDebug(null);
          return;
        }
        // Always send code with every request
        const listeningUrl = `https://spotcord-1.onrender.com/listening?code=${encodeURIComponent(code)}`;
        const response = await fetch(listeningUrl, { credentials: 'include' });
        const data = await response.json();
        if (response.status === 401 || data.error) {
          setError(data.error || 'Not authenticated');
          setCurrentSong(null);
          setSongId(null);
          setSpotifyUser(null);
          setSpotifyUserDebug(null);
          return;
        }
        if (data.is_playing && data.track_id) {
          setCurrentSong({
            title: data.track_name,
            artist: data.artists,
            album: data.album_name,
            duration: data.duration,
            progress: data.progress,
            albumArt: data.album_image_url,
            isPlaying: true,
          });
          setSongId(data.track_id);
          // Use first artist for artist mode
          if (data.artists) {
            setArtist(data.artists.split(',')[0].trim());
          } else {
            setArtist(null);
          }
        } else {
          setCurrentSong(null);
          setSongId(null);
          setArtist(null);
        }
        // Always fetch Spotify user profile for this code
        try {
          const userResp = await fetch(`https://spotcord-1.onrender.com/spotify_user?code=${encodeURIComponent(code)}`);
          const userData = await userResp.json();
          setSpotifyUser(userData.display_name || userData.id || null);
          setSpotifyUserDebug(JSON.stringify(userData));
        } catch (e) {
          setSpotifyUser(null);
          setSpotifyUserDebug('Error: ' + e.message);
        }
      } catch (err) {
        setCurrentSong(null);
        setSongId(null);
        setSpotifyUser(null);
        setSpotifyUserDebug(null);
        setError('Network or server error');
        console.error("Error fetching track:", err);
      }
    };
    fetchNowPlaying();
    const interval = setInterval(fetchNowPlaying, 5000); // update every 1s
    return () => clearInterval(interval);
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

  return (
  <div className="fixed inset-0 w-screen h-screen bg-black text-gray-100 overflow-hidden flex">
    {/* Sidebar */}
  <aside className="w-28 min-w-24 h-full flex flex-col bg-[#18191a] border-r border-[#23272a] shadow-lg p-3 gap-4 justify-between">
      <div className="flex flex-col items-center gap-4">
        {spotifyUser && (
          <span className="text-xs text-[#43b581] text-center">{spotifyUser}</span>
        )}
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
          window.location.href = getSpotifyAuthUrl();
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
                  <div className="flex items-center gap-3 mt-2">
                    <button
                      onClick={() => window.SpotcordPlayerControls?.previous()}
                      className="bg-[#2c2f33] text-white px-3 py-1 rounded"
                    >Prev</button>
                    <button
                      onClick={() => window.SpotcordPlayerControls?.play()}
                      className="bg-[#5865f2] text-white px-3 py-1 rounded"
                    >Play</button>
                    <button
                      onClick={() => window.SpotcordPlayerControls?.pause()}
                      className="bg-[#2c2f33] text-white px-3 py-1 rounded"
                    >Pause</button>
                    <button
                      onClick={() => window.SpotcordPlayerControls?.next()}
                      className="bg-[#2c2f33] text-white px-3 py-1 rounded"
                    >Next</button>
                  </div>
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

        {/* Sidebar */}
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
        </aside>
      </main>
      <Analytics />
      <div>
        <WebPlayer code={sessionStorage.getItem('spotify_code')} />
      </div>
  </div>
  );
};

export default App;

// Fixed bottom player bar
export function BottomPlayer() {
  const code = sessionStorage.getItem('spotify_code');
  if (!code) return null;
  return (
    <div className="fixed left-28 right-0 bottom-4 p-4">
      <div className="bg-[#111213] rounded-lg border border-[#23272a] p-3">
        <WebPlayer code={code} />
      </div>
    </div>
  );
}