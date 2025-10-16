// Spotify OAuth config
const SPOTIFY_CLIENT_ID = "51dd9a50cd994a7e8e374fc2169c6f25";
const SPOTIFY_REDIRECT_URI = "https://spotcord-1.onrender.com/callback";
const SPOTIFY_SCOPES = "user-read-currently-playing user-read-playback-state user-read-private";

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
import { io } from 'socket.io-client';
import { MessageCircle, Music, User, Send, Heart, Play, Pause } from 'lucide-react';

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
  const [spotifyUser, setSpotifyUser] = useState(null);
  const [spotifyUserDebug, setSpotifyUserDebug] = useState(null);
  const [error, setError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  // Generate or load a random username for the current user
  const randomNames = [
    "NebulaFox", "PixelPenguin", "EchoWolf", "LunaTiger", "NovaBear", "ShadowOtter", "BlazeHawk", "FrostLion", "VibeKoala", "ZenPanda",
    "MossyFawn", "CometSeal", "JazzMoose", "RiftBison", "GaleMoth", "RuneCrab", "DuskMarten", "QuillJay", "SableMole", "WispMink"
  ];
  function getRandomName() {
    return randomNames[Math.floor(Math.random() * randomNames.length)];
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
    { id: username + '-' + Math.random().toString(36).slice(2, 8), name: username, avatar: "https://placehold.co/32x32/1db954/ffffff?text=U" }
  ]);


  // Track songId for lobby
  const [songId, setSongId] = useState(null);
  const socketRef = useRef(null);
  const lobbyRef = useRef(null);

  // Fetch from Flask backend and set songId
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
        } else {
          setCurrentSong(null);
          setSongId(null);
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
    const interval = setInterval(fetchNowPlaying, 1000); // update every 1s
    return () => clearInterval(interval);
  }, []);


  // Update URL to /lobby/<track_id> or /lobby/general ONLY when the current user's songId changes
  // This ensures the URL is user-specific and not affected by other users
  useEffect(() => {
    const newPath = songId ? `/lobby/${songId}` : '/lobby/general';
    if (window.location.pathname !== newPath) {
      window.history.replaceState({}, '', newPath);
    }
  }, [songId]);


  // Connect to socket.io namespace for this songId or general
  useEffect(() => {
    const lobby = songId ? songId : 'general';
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
    socket.emit('join', { username, songId });
    socket.on('online-users', (users) => {
      setOnlineUsers(users.map(name => ({
        id: name + '-' + Math.random().toString(36).slice(2, 8),
        name,
        avatar: name === username
          ? "https://placehold.co/32x32/1db954/ffffff?text=U"
          : `https://placehold.co/32x32/5865f2/ffffff?text=${encodeURIComponent(name[0] || 'U')}`
      })));
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
      lobbyRef.current = null;
    };
  }, [username, songId]);



  const handleSendMessage = () => {
    if (!newMessage.trim()) return;
    const msg = {
      id: messages.length + 1,
      user: username,
      avatar: "https://placehold.co/40x40/1db954/ffffff?text=U",
      message: newMessage,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      likes: 0
    };
    setMessages([...messages, msg]);
    setNewMessage("");
  };

  const handleLikeMessage = (id) => {
    setMessages(messages.map(m => m.id === id ? { ...m, likes: m.likes + 1 } : m));
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') handleSendMessage();
  };

  return (
  <div className="fixed inset-0 w-screen h-screen bg-gradient-to-br from-[#23272a] via-[#2c2f33] to-[#23272a] text-gray-100 font-sans overflow-auto">
      {/* Header */}
      <header className="w-full px-6 py-4 flex items-center justify-between bg-[#23272a] border-b border-[#36393f] shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#5865f2] rounded-xl flex items-center justify-center shadow">
            <Music className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Spotcord</h1>
          {spotifyUser && (
            <span className="ml-4 text-sm text-[#43b581]">Logged in as <span className="font-semibold">{spotifyUser}</span></span>
          )}
          {/* Logout button for stateless session */}
          <button
            className="ml-4 px-3 py-1 bg-[#ed4245] text-white rounded-lg text-xs font-semibold hover:bg-[#b3242a] transition"
            onClick={() => {
              sessionStorage.clear();
              window.location.reload();
            }}
          >
            Log out
          </button>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-[#2c2f33] rounded-lg px-4 py-2 text-gray-300 text-sm shadow">
            <User className="w-4 h-4" />
            <span>{onlineUsers.length} online</span>
          </div>
        </div>
      </header>

  <main className="w-full h-full px-2 py-6 flex flex-col lg:flex-row gap-6">
          {/* Current Song Section */}
        {/* Main Content (Current Song + Chat) */}
        <section className="flex-1 flex flex-col gap-6">
          <div className="bg-[#2c2f33] rounded-2xl p-6 shadow-lg border border-[#23272a]">
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
                </div>
              </div>
            )}
          </div>
          {/* Chat Section */}
          <div className="flex-1 flex flex-col bg-[#2c2f33] rounded-2xl shadow-lg border border-[#23272a]">
            <div className="px-6 py-4 border-b border-[#23272a] bg-[#23272a] rounded-t-2xl">
              <h3 className="text-lg font-semibold flex items-center gap-2 text-[#b9bbbe]">
                <MessageCircle className="w-5 h-5" />
                Chat
              </h3>
              <p className="text-xs text-[#72767d] mt-1">{onlineUsers.length} online</p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              {messages.map(msg => (
                <div key={msg.id} className="flex items-start gap-3">
                  <img src={msg.avatar} alt={msg.user} className="w-10 h-10 rounded-full border border-[#23272a]" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sm text-white">{msg.user}</span>
                      <span className="text-[#72767d] text-xs">{msg.timestamp}</span>
                    </div>
                    <p className="text-[#dcddde] text-sm mb-2">{msg.message}</p>
                    <button
                      onClick={() => handleLikeMessage(msg.id)}
                      className="flex items-center gap-1 text-[#72767d] hover:text-[#ed4245] text-xs"
                    >
                      <Heart className="w-3 h-3" />
                      <span>{msg.likes}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-[#23272a] p-4 flex gap-3 bg-[#23272a] rounded-b-2xl">
              <input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message..."
                className="flex-1 bg-[#36393f] border border-[#23272a] rounded-lg px-4 py-3 text-white placeholder-[#72767d] focus:outline-none focus:ring-2 focus:ring-[#5865f2]"
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
          <div className="bg-[#2c2f33] rounded-2xl p-6 shadow-lg border border-[#23272a]">
            <h3 className="text-md font-semibold mb-4 flex items-center gap-2 text-[#b9bbbe]">
              <div className="w-3 h-3 bg-[#43b581] rounded-full mr-2"></div>
              Online Users
            </h3>
            <div className="flex flex-col gap-2">
              {onlineUsers.map(u => (
                <div key={u.id} className="flex items-center gap-3 p-2 hover:bg-[#23272a] rounded-lg transition-colors">
                  <img src={u.avatar} alt={u.name} className="w-8 h-8 rounded-full border border-[#23272a]" />
                  <span className="text-sm text-white">{u.name}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </main>
  </div>
  );
};

export default App;