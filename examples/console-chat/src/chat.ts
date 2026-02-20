/**
 * MIT License
 * 
 * Copyright (c) 2026 RocketRide, Inc.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Console Chat Application
 * 
 * A command-line interface application that provides interactive chat capabilities
 * using the RocketRide SDK. This application connects to a RocketRide server, initializes
 * a chat pipeline, and allows users to have conversational interactions with AI.
 * 
 * Features:
 * - Interactive command-line chat interface
 * - Configurable RocketRide server connection
 * - Pipeline-based chat configuration
 * - Graceful connection handling and error management
 * 
 * @example
 * ```bash
 * # Run the application
 * node console-chat-app.js
 * 
 * # Interact with the chat
 * > Hello, how are you?
 * AI: I'm doing well, thank you for asking!
 * 
 * # Exit the application
 * > exit
 * ```
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import {
	RocketRideClient,
	Question,
	PipelineConfig
} from "rocketride";

/**
 * Initialize readline interface for user input/output
 * This enables interactive command-line communication
 */
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

// Display welcome message
console.log("Welcome to the Console Chat App with RocketRide SDK!");
console.log("Type 'exit' to quit.");

/**
 * Main application function
 * 
 * Handles the complete lifecycle of the chat application:
 * 1. Connects to the RocketRide server
 * 2. Loads and initializes the chat pipeline
 * 3. Starts the interactive chat loop
 * 4. Handles cleanup on exit
 * 
 * @async
 */
async function main(): Promise<void> {
	// Initialize the RocketRide client. Uses ROCKETRIDE_URI and ROCKETRIDE_APIKEY from
	// process.env (e.g. from .env via dotenv) or pass auth/uri in the config object.
	const client = new RocketRideClient({
		auth: process.env.ROCKETRIDE_APIKEY,
		uri: process.env.ROCKETRIDE_URI
	});

	// Attempt to establish connection to the RocketRide server
	try {
		await client.connect();
		console.log("Connected to RocketRide server.");
	} catch (error: unknown) {
		console.error("Failed to connect to RocketRide server:", error instanceof Error ? error.message : error);
		rl.close();
		return;
	}

	// Load the pipeline configuration from the JSON file
	// The pipeline defines how the chat system processes and responds to messages
	const pipelineFile = path.join(__dirname, "chat.pipe.json");
	let chatPipeline: PipelineConfig;

	try {
		const pipelineJson = fs.readFileSync(pipelineFile, "utf-8");
		chatPipeline = JSON.parse(pipelineJson) as PipelineConfig;
	} catch (error: unknown) {
		console.error("Failed to load pipeline configuration:", error instanceof Error ? error.message : error);
		await client.disconnect();
		rl.close();
		return;
	}

	// Initialize the chat pipeline and obtain an access token
	// This token is used for all subsequent chat operations
	let chatToken: string;

	try {
		const response = await client.use({ pipeline: chatPipeline, useExisting: true });
		chatToken = response.token;
		if (!chatToken) {
			console.error("Failed to initialize chat pipeline: no token returned.");
			await client.disconnect();
			rl.close();
			return;
		}
		console.log("Chat pipeline initialized.");
	} catch (error: unknown) {
		console.error("Failed to initialize chat pipeline:", error instanceof Error ? error.message : error);
		await client.disconnect();
		rl.close();
		return;
	}

	/**
	 * Interactive chat loop
	 * 
	 * Continuously prompts the user for input and processes their messages:
	 * - "exit" command terminates the chat and disconnects
	 * - Empty input is ignored with a helpful message
	 * - Valid messages are sent to the AI and responses are displayed
	 * 
	 * This function calls itself recursively to maintain the conversation loop.
	 * 
	 * @async
	 */
	async function chatLoop(): Promise<void> {
		rl.question("> ", async (input: string) => {
			// Check if user wants to exit the application
			if (input.toLowerCase() === "exit") {
				try {
					// Terminate the chat pipeline to clean up resources
					await client.terminate(chatToken);
				} catch {
					// Ignore termination errors - we're exiting anyway
				}

				// Disconnect from the RocketRide server
				await client.disconnect();
				console.log("Goodbye!");
				rl.close();
				return;
			}
			// Handle empty input
			else if (input.trim() === "") {
				console.log("Please enter a message.");
			}
			// Process valid user input
			else {
				try {
					// Create a Question object to encapsulate the user's input
					const question = new Question();
					question.addQuestion(input);

					// Send the question to RocketRide's AI chat service
					const result = await client.chat({
						token: chatToken,
						question: question
					});

					// Parse and display the AI response
					// The result structure is dynamic based on the pipeline's result_types
					if (result && result.result_types) {
						// Iterate through result fields to find the answers
						for (const [fieldName, fieldType] of Object.entries(result.result_types)) {
							// Look for the field designated as containing answers
							if (fieldType === "answers" && result[fieldName]) {
								const answers = result[fieldName];

								// Handle both array and single answer formats
								if (Array.isArray(answers) && answers.length > 0) {
									console.log(`AI: ${answers[0]}`);
								} else {
									console.log(`AI: ${answers}`);
								}
								break;
							}
						}
					} else {
						// No response received from the AI
						console.log("AI: (no response)");
					}
				} catch (error: unknown) {
					// Display any errors that occur during the chat interaction
					console.error("Chat error:", error instanceof Error ? error.message : error);
				}
			}

			// Continue the chat loop for the next user input
			chatLoop();
		});
	}

	// Start the interactive chat loop
	chatLoop();
}

// Execute the main application function
main();
