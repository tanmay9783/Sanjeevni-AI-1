import { createContext, useContext, useEffect, useRef, useState } from "react";

const backendUrl = import.meta.env.VITE_API_URL || "http://localhost:3125";

const ChatContext = createContext();

export const ChatProvider = ({ children }) => {
  const [messages, setMessages]           = useState([]);
  const [message, setMessage]             = useState(null);
  const [loading, setLoading]             = useState(false);
  const [cameraZoomed, setCameraZoomed]   = useState(true);
  const [pythonPlaying, setPythonPlaying] = useState(false);

  const pythonPlayingRef = useRef(false);
  const isSendingRef     = useRef(false);
  const lastPayloadTsRef = useRef(0);

  // ── chat() — blocked entirely while Python is active ─────────────────────
  const chat = async (messageText, patientData = null) => {
    if (!messageText?.trim() && !patientData) return [];
    if (isSendingRef.current) return [];
    if (pythonPlayingRef.current) {
      console.log("🔇 chat() blocked — Python is speaking");
      return [];
    }

    isSendingRef.current = true;
    setLoading(true);

    try {
      const response = await fetch(`${backendUrl}/chat`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ message: messageText, patientData }),
      });

      // 423 = pythonMode active on Node side (double guard)
      if (response.status === 423) {
        console.log("🔒 /chat returned 423 — Python mode active on server");
        return [];
      }

      const data = await response.json();
      if (!response.ok) { console.error("Backend error:", data); return []; }

      const resp = Array.isArray(data?.messages) ? data.messages : [];
      if (resp.length === 0) { console.error("No messages:", data); return []; }

      setMessages((prev) => [...prev, ...resp]);
      return resp;
    } catch (error) {
      console.error("Chat request failed:", error);
      return [];
    } finally {
      setLoading(false);
      isSendingRef.current = false;
    }
  };

  // ── Normal React message queue ────────────────────────────────────────────
  const onMessagePlayed = () => {
    setMessages((prev) => prev.slice(1));
  };

  const playCustomMessage = (text, audioBase64, lipsync) => {
    setMessages((prev) => [
      ...prev,
      { text, audio: audioBase64, lipsync, facialExpression: "smile", animation: "Talking_1" },
    ]);
  };

  // ── Python avatar: set message directly, bypass queue ────────────────────
  const playPythonMessage = (payload) => {
    console.log("🎭 playPythonMessage — cues:", payload.lipsync?.mouthCues?.length);

    setPythonPlaying(true);
    pythonPlayingRef.current = true;

    // Wipe any queued React messages so Python takes over cleanly
    setMessages([]);

    setMessage({
      text:             payload.text             || "",
      audio:            payload.audio,
      lipsync:          payload.lipsync          || { mouthCues: [] },
      facialExpression: payload.facialExpression || "smile",
      animation:        payload.animation        || "Talking_1",
      _pythonSource:    true,
    });
  };

  // ── Poll /get-avatar-payload every 1s ────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`${backendUrl}/get-avatar-payload`);
        const data = await res.json();

        if (data?.payload) {
          const p = data.payload;
          if (p.timestamp && p.timestamp <= lastPayloadTsRef.current) return;
          lastPayloadTsRef.current = p.timestamp || Date.now();
          playPythonMessage(p);
        }
      } catch (_) {}
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // ── Normal queue → message (skip if Python is playing) ───────────────────
  useEffect(() => {
    if (pythonPlayingRef.current) return;
    setMessage(messages.length > 0 ? messages[0] : null);
  }, [messages]);

  // ── onMessagePlayed — aware of Python vs React source ────────────────────
  const onMessagePlayedWrapped = () => {
    if (message?._pythonSource) {
    //   console.log("✅ Python message finished");
    //   setPythonPlaying(false);
    //   pythonPlayingRef.current = false;
    //   setMessage(null);
    // } else {
    //   onMessagePlayed();
    console.log("✅ Python message finished — unmuting React");
    setPythonPlaying(false);
    pythonPlayingRef.current = false;
    setMessage(null);
    // ✅ Also clear any messages that queued up while Python was playing
    setMessages([]);
    // ✅ Now tell Node to unmute too
    fetch(`${backendUrl}/python-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    }).catch(() => {});
  } else {
    onMessagePlayed();
    }
  };

  return (
    <ChatContext.Provider
      value={{
        chat,
        message,
        messages,
        onMessagePlayed: onMessagePlayedWrapped,
        playCustomMessage,
        loading,
        cameraZoomed,
        setCameraZoomed,
        pythonPlaying,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) throw new Error("useChat must be used within a ChatProvider");
  return context;
};

