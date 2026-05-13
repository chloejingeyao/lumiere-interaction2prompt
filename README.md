# **Lumiere (interaction2prompt)**

A lightweight Chrome extension designed for creators, designers, and AI coding users to seamlessly translate **dynamic UI interactions** into production-ready prompts.

## **Overview**

I built Lumiere out of necessity during late-night "vibe coding" sessions. While finding an incredible interactive UI across the web is easy, translating the living behaviors into precise language for an AI agent is incredibly frustrating. Without the exact technical vocabulary, you get stuck in token-wasting back-and-forth loops that result in generic "AI slop."

Lumiere fixes this. It captures any live UI element and its interactions, instantly generating a high-fidelity technical prompt. It gives your AI companion the exact context needed to execute flawlessly on the first try, so you can stop wrestling with prompts and keep shipping.

## **Features**

🔒 **Privacy & Security:** Your API keys are stored locally in your browser's extension storage (chrome.storage). They are sent directly from your machine to the respective AI provider (Google/Anthropic) to handle your requests. Your keys are never collected, shared, or sent to any external servers.

| Feature Module | Description |
| :---- | :---- |
| **Model Selection** | Switch between Gemini 2.5 Flash and Claude Haiku—each maintains its own API key and model ID. |
| **Any Interaction** | Select any element on a webpage and record an interaction of up to 10 seconds. |
| **Domain Filters** | Hide the capture button on excluded sites to ensure your browsing experience stays distraction-free. |
| **Open Source & Free** | 100% open-source and completely free to use. |
| **Generation History** | View all your previously generated prompts at any time *(Coming soon)*. |
| **Prompt Templates** | Edit and customize prompt generation templates to craft your unique style *(Coming soon)*. |
| **Custom Instructions** | Enable a pre-generation dialog to blend bespoke extra guidance into every single output *(Coming soon)*. |

## **Installation**

To get Lumiere running locally in developer mode, follow these steps:

* **Clone or download** this repository to your local machine.  
* Open your browser's extensions page by navigating to chrome://extensions/ (or edge://extensions/ for Edge).  
* Toggle on **Developer mode** in the top-right corner.  
* **Install the extension** using one of these methods:  
  * Drag and drop the entire project folder directly into the extensions page.  
  * Alternatively, click the Load unpacked button and select the project folder from your file directory.

## **Configuration & Usage**

### **1\. Set Up Your API Keys**

Before your first capture, configure the API key for your preferred model within the extension settings interface:

* **Gemini:** [Google AI Studio](https://aistudio.google.com/app/api-keys)  
* **Claude:** [Claude console](https://platform.claude.com/login?returnTo=%2F%3F)

### **2\. Capture and Generate**

* Whenever you spot an **interactive UI pattern or dynamic component** you want to replicate, launch the Lumiere extension.  
* Click **"Select Element"** and click to target the desired component on the webpage.  
* Record its corresponding interactions (up to 10 seconds) to feed the prompt generator.  
* Copy your high-fidelity prompt and drop it straight into your AI coding companion\!

## **Contact**

Built by Chloe Yao — feel free to reach out or connect.

* 🌐 [chloeyao.com](https://chloeyao.com/)
* 💼 [LinkedIn](https://www.linkedin.com/in/jychloe/)
* ✉️ [jy126c@gmail.com](mailto:jy126c@gmail.com)

