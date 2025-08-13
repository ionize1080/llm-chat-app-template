/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const modelSelect = document.getElementById("model-select");

/**
 * Render Markdown to HTML using marked if available.
 */
let markedConfigured = false;

function renderMarkdown(text) {
  if (window.marked) {
    if (window.hljs && !markedConfigured) {
      window.marked.setOptions({
        highlight(code, lang) {
          if (lang && window.hljs.getLanguage(lang)) {
            return window.hljs.highlight(code, { language: lang }).value;
          }
          return window.hljs.highlightAuto(code).value;
        },
      });
      markedConfigured = true;
    }
    return window.marked.parse(text);
  }
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Highlight all code blocks within an element
 */
function addCopyButtons(el) {
  el.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy-btn")) return;
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code");
      const text = code ? code.innerText : pre.innerText;
      navigator.clipboard
        .writeText(text)
        .then(() => {
          btn.textContent = "Copied!";
          setTimeout(() => (btn.textContent = "Copy"), 2000);
        })
        .catch(() => {
          btn.textContent = "Failed";
          setTimeout(() => (btn.textContent = "Copy"), 2000);
        });
    });
    pre.appendChild(btn);
  });
}

function highlightCode(el) {
  if (window.hljs) {
    el.querySelectorAll("pre code").forEach((block) => {
      window.hljs.highlightElement(block);
    });
  }
  addCopyButtons(el);
}

// Chat state
let chatHistory = [
  {
    role: "assistant",
    content:
      "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
  },
];
let isProcessing = false;

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
  const message = userInput.value.trim();

  // Don't send empty messages
  if (message === "" || isProcessing) return;

  // Disable input while processing
  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  // Add user message to chat
  addMessageToChat("user", message);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

  // Show typing indicator
  typingIndicator.classList.add("visible");

  // Add message to history
  chatHistory.push({ role: "user", content: message });

  try {
    // Create new assistant response element
    const assistantMessageEl = document.createElement("div");
    assistantMessageEl.className = "message assistant-message";
    assistantMessageEl.innerHTML = "";
    chatMessages.appendChild(assistantMessageEl);
    highlightCode(assistantMessageEl);

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Send request to API
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: chatHistory,
        model: modelSelect.value,
      }),
    });

    // Blocked region handling
    if (response.status === 403) {
      const data = await response.json().catch(() => ({}));
      addMessageToChat("assistant", data.error || "网站正在建设中");
      return;
    }

    // Handle other errors
    if (!response.ok) {
      throw new Error("Failed to get response");
    }

    // Process streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        // Find lines that start with "data:", which is the SSE format
        if (line.trim().startsWith("data:")) {
          // Get the JSON string by removing "data:"
          const jsonStr = line.replace(/^data:\s*/, '');
          
          // Some streams might send a special [DONE] message
          if (jsonStr === '[DONE]') {
            break;
          }

          try {
            const jsonData = JSON.parse(jsonStr);
            let content = '';

            // **THIS IS THE KEY FIX**
            // Check for the standard format (Llama, Deepseek, etc.)
            if (jsonData.response) {
              content = jsonData.response;
            } 
            // Check for the OpenAI-compatible format
            else if (jsonData.choices && jsonData.choices[0]?.delta?.content) {
              content = jsonData.choices[0].delta.content;
            }

            // If we found content, append it and update the UI
            if (content) {
              responseText += content;
              assistantMessageEl.innerHTML = renderMarkdown(responseText);
              highlightCode(assistantMessageEl);
              chatMessages.scrollTop = chatMessages.scrollHeight;
            }
          } catch (e) {
            // Log errors but don't break the loop, as some lines might be empty
            console.error("Could not parse JSON chunk:", jsonStr, e);
          }
        }
      }
    }

    // Add completed response to chat history
    chatHistory.push({ role: "assistant", content: responseText });
  } catch (error) {
    console.error("Error:", error);
    addMessageToChat(
      "assistant",
      "Sorry, there was an error processing your request.",
    );
  } finally {
    // Hide typing indicator
    typingIndicator.classList.remove("visible");

    // Re-enable input
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  if (role === "assistant") {
    messageEl.innerHTML = renderMarkdown(content);
  } else {
    const p = document.createElement("p");
    p.textContent = content;
    messageEl.appendChild(p);
  }
  chatMessages.appendChild(messageEl);

  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
  highlightCode(messageEl);
}
