import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import { moment } from 'obsidian'; // Import moment for robust date handling

// Interface for plugin settings
interface TodoistCompletedTasksSettings {
	todoistApiToken: string;
    // Optional: Add setting for date format if needed later
    // dailyNoteFormat: string;
}

// Default settings
const DEFAULT_SETTINGS: TodoistCompletedTasksSettings = {
	todoistApiToken: '',
    // dailyNoteFormat: 'YYYY-MM-DD' // Example if we add setting
}

// Interface for Todoist Project structure (simplified)
interface TodoistProject {
    id: string;
    name: string;
}

// Main Plugin Class
export default class TodoistCompletedTasksPlugin extends Plugin {
	settings: TodoistCompletedTasksSettings;

	// --- Lifecycle Methods ---

	async onload() {
		console.log('Loading Todoist Completed Tasks plugin');
		await this.loadSettings();

		// Updated command description
		this.addCommand({
			id: 'fetch-todoist-completed-tasks-for-note', // New ID for clarity
			name: 'Fetch Todoist Tasks Completed (for Note Date or Today)',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.fetchAndInsertTasksForView(editor, view); // Call the new handler
			}
		});

		this.addSettingTab(new TodoistSettingTab(this.app, this));
		console.log('Todoist Completed Tasks plugin loaded.');
	}

	onunload() {
		console.log('Unloading Todoist Completed Tasks plugin');
	}

	// --- Settings Management ---

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// --- Helper Function to Fetch Project Data (Unchanged) ---

	async fetchProjectData(): Promise<Map<string, string>> {
        // ... (Keep the existing fetchProjectData function exactly as it was) ...
		const projectsMap = new Map<string, string>();
		if (!this.settings.todoistApiToken) {
			throw new Error('Todoist API token is not set.');
		}

		try {
            // Use the Sync API to get all projects
			const syncUrl = `https://api.todoist.com/sync/v9/sync?sync_token=*&resource_types=["projects"]`;
			const response = await requestUrl({
				url: syncUrl,
				method: 'GET', // Sync API uses GET
				headers: {
					'Authorization': `Bearer ${this.settings.todoistApiToken}`
				}
			});

			if (response.status !== 200) {
				throw new Error(`Todoist Sync API error: ${response.status} - ${response.text}`);
			}

			const data = response.json;
			if (data && data.projects) {
				data.projects.forEach((project: TodoistProject) => {
					projectsMap.set(project.id, project.name);
				});
			}
            return projectsMap;

		} catch (error) {
			console.error('Error fetching Todoist project data:', error);
            // Re-throw the error so the calling function knows something went wrong
			throw new Error(`Failed to fetch project data: ${error.message}`);
		}
	}


	// --- Core Functionality ---

    /**
     * Determines the target date based on the active view (daily note or today)
     * and then fetches and inserts the completed tasks.
     */
    async fetchAndInsertTasksForView(editor: Editor, view: MarkdownView) {
        let targetDate = moment(); // Default to today
        let dateSource = "today";

        const activeFile = view.file; // Get the file associated with the current view

        if (activeFile) {
            // Try to parse date from filename assuming YYYY-MM-DD format
            // Using moment for more robust parsing and formatting
            const filenameDateMatch = activeFile.basename.match(/^(\d{4}-\d{2}-\d{2})$/);
            if (filenameDateMatch) {
                const parsedDate = moment(filenameDateMatch[1], 'YYYY-MM-DD', true); // Use strict parsing
                if (parsedDate.isValid()) {
                    targetDate = parsedDate;
                    dateSource = `note filename (${targetDate.format('YYYY-MM-DD')})`;
                }
            }
            // Note: Could add more complex logic here to check Daily Notes plugin settings
            // for format and folder if needed for more robustness.
        }

        if (!this.settings.todoistApiToken) {
			new Notice('Todoist API token is not set. Please configure it in the plugin settings.');
			return;
		}

        new Notice(`Fetching Todoist tasks completed for ${dateSource}...`);

        try {
            const markdownOutput = await this.fetchAndFormatTasksForDate(targetDate.toDate()); // Pass JS Date object
            editor.replaceSelection(markdownOutput);
            // Notice updated in the fetchAndFormatTasksForDate function
        } catch (error) {
            console.error('Error fetching or processing Todoist data:', error);
			new Notice(`Error: ${error.message}`);
        }
    }


    /**
     * Fetches completed tasks and project data for a specific date,
     * then formats them into a Markdown string.
     * @param targetDate The date for which to fetch completed tasks.
     * @returns A promise that resolves with the formatted Markdown string.
     */
	async fetchAndFormatTasksForDate(targetDate: Date): Promise<string> {
		// Ensure API token is checked here as well, although fetchAndInsertTasksForView does it too
        if (!this.settings.todoistApiToken) {
			throw new Error('Todoist API token is not set.');
		}

        // 1. Fetch Project Data
        const projects = await this.fetchProjectData();
        // No notice needed here, the calling function handles initial notice

		// 2. Fetch Completed Tasks Activity for the targetDate
        const targetMoment = moment(targetDate); // Use moment for formatting
        const targetDateString = targetMoment.format('YYYY-MM-DD');

        const limit = 100; // How many activity items to fetch
        const apiUrl = `https://api.todoist.com/sync/v9/activity/get?object_type=item&event_type=completed&limit=${limit}`;
        // We will filter by date *after* fetching, as the API 'since'/'until' can be tricky with timezones.
        // Fetching a broader range and filtering locally is often more reliable for specific dates.

        const response = await requestUrl({
            url: apiUrl,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.settings.todoistApiToken}`,
            },
        });

		if (response.status !== 200) {
			throw new Error(`Todoist Activity API error: ${response.status} - ${response.text}`);
		}

		const data = response.json;

        if (!data || !data.events) {
            throw new Error('Invalid response structure from Todoist Activity API');
        }

		// Filter events that occurred on the targetDate
        // Important: Compare dates carefully, ignoring time if possible or handling timezones
        const completedOnDateEvents = data.events.filter((event: any) => {
            if (!event.event_date) return false;
            // Parse event_date (assuming UTC or consistent format) and check if it matches targetDate
            // Moment's isSame check is good for this
            const eventMoment = moment.utc(event.event_date); // Assume event_date is UTC
            return eventMoment.isSame(targetMoment, 'day');
        });

		if (completedOnDateEvents.length === 0) {
            const friendlyDate = targetMoment.isSame(moment(), 'day') ? 'today' : targetDateString;
			new Notice(`No tasks completed on ${friendlyDate} found in Todoist.`);
			return ""; // Return empty string if no tasks
		}

        // 3. Group tasks by Project ID
        const tasksByProject = new Map<string | null, any[]>();
        completedOnDateEvents.forEach((event: any) => {
            const projectId = event.parent_project_id || null;
            if (!tasksByProject.has(projectId)) {
                tasksByProject.set(projectId, []);
            }
            tasksByProject.get(projectId)?.push(event);
        });

		// 4. Format tasks as Markdown list, grouped by project
        const friendlyDateString = targetMoment.isSame(moment(), 'day') ? 'Today' : targetDateString;
		let markdownOutput = `## Tasks Completed ${friendlyDateString}\n\n`;

        const sortedProjectIds = Array.from(tasksByProject.keys()).sort((a, b) => {
            const nameA = a ? projects.get(a) ?? 'Unknown Project' : 'No Project';
            const nameB = b ? projects.get(b) ?? 'Unknown Project' : 'No Project';
            if (a === null) return 1; // Put "No Project" last
            if (b === null) return -1;
            return nameA.localeCompare(nameB);
        });

        for (const projectId of sortedProjectIds) {
            const projectName = projectId ? projects.get(projectId) : null;
            const projectTasks = tasksByProject.get(projectId) || [];

            if (projectName) {
                markdownOutput += `### ${projectName}\n`;
            } else if (projectId === null) {
                 markdownOutput += `### No Project\n`;
            } else {
                markdownOutput += `### Unknown Project (ID: ${projectId})\n`;
            }

            projectTasks.forEach((event: any) => {
                const taskId = event.object_id;
                const taskContent = event.extra_data?.content || `Task ID ${taskId}`;
                const taskUrl = `https://todoist.com/showTask?id=${taskId}`;
                markdownOutput += `- [${taskContent}](${taskUrl})\n`;
            });
            markdownOutput += '\n';
        }

        new Notice(`Inserted ${completedOnDateEvents.length} tasks completed on ${targetDateString}.`);
        return markdownOutput; // Return the formatted string
	}
}

// --- Settings Tab Class (Unchanged) ---

class TodoistSettingTab extends PluginSettingTab {
	plugin: TodoistCompletedTasksPlugin;

	constructor(app: App, plugin: TodoistCompletedTasksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		// ... (Keep the existing display function exactly as it was) ...
        const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Todoist Completed Tasks Settings' });

		new Setting(containerEl)
			.setName('Todoist API Token')
			.setDesc('Enter your Todoist API token (found in Todoist Settings -> Integrations -> Developer)')
			.addText(text => text
				.setPlaceholder('Enter your token')
				.setValue(this.plugin.settings.todoistApiToken)
				.onChange(async (value) => {
					this.plugin.settings.todoistApiToken = value.trim();
					await this.plugin.saveSettings();
				}));
	}
}
