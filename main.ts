import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import { moment } from 'obsidian';

// Interface for plugin settings
interface TodoistCompletedTasksSettings {
    todoistApiToken: string;
    dailyNoteFormat: string;
}

// Default settings
const DEFAULT_SETTINGS: TodoistCompletedTasksSettings = {
    todoistApiToken: '',
    dailyNoteFormat: 'YYYY-MM-DD'
}

// Interface for Todoist Project structure (simplified)
interface TodoistProject {
    id: string;
    name: string;
    color: string;
}

interface TodoistProjectResponse {
    results: TodoistProject[];
    next_cursor: string | null;
}

// Partial interface, see https://todoist.com/api/v1/docs#tag/Tasks/operation/tasks_completed_by_completion_date_api_v1_tasks_completed_by_completion_date_get
interface TodoistCompletedTask {
    id: string;
    project_id: string;
    section_id: string;
    labels: string[];
    checked: boolean;
    is_deleted: boolean;
    content: string;
    description: string;
    priority: number;
}

interface TodoistCompletedTasksResponse {
    items: TodoistCompletedTask[];
    next_cursor: string | null;
}

// Main Plugin Class
export default class TodoistCompletedTasksPlugin extends Plugin {
    settings: TodoistCompletedTasksSettings;

    // --- Lifecycle Methods ---

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'fetch-todoist-completed-tasks-for-note',
            name: 'Insert completed tasks for day',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.fetchAndInsertTasksForView(editor, view);
            }
        });

        this.addSettingTab(new TodoistSettingTab(this.app, this));
    }

    onunload() {
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
        const projectsMap = new Map<string, string>();
        if (!this.settings.todoistApiToken) {
            throw new Error('Todoist API token is not set.');
        }

        try {
            const url = `https://todoist.com/api/v1/projects?limit=200`;
            const response = await requestUrl({
                url,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.settings.todoistApiToken}`
                }
            });

            if (response.status !== 200) {
                throw new Error(`Todoist Get Projects API error: ${response.status} - ${response.text}`);
            }

            const data = response.json as TodoistProjectResponse;
            if (data && data.results) {
                data.results.forEach((project: TodoistProject) => {
                    new Notice(`Project {project.name} as color ${project.color}`);
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
            // Check if the file matches the daily note format
            const dailyNoteFormat = this.settings.dailyNoteFormat || 'YYYY-MM-DD';
            const parseDate = moment(activeFile.basename, dailyNoteFormat, true); // Use strict parsing
            if (parseDate.isValid()) {
                targetDate = parseDate;
                dateSource = `note filename (${targetDate.format(dailyNoteFormat)})`;
            }
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

        const sinceDate = targetMoment.clone().startOf('day').toISOString(); // Start of the day
        const untilDate = targetMoment.clone().endOf('day').toISOString(); // End of the day

        const limit = 100; // How many activity items to fetch
        const apiUrl = `https://todoist.com/api/v1/tasks/completed/by_completion_date?since=${sinceDate}&until=${untilDate}&limit=${limit}`;
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

        const data = response.json as TodoistCompletedTasksResponse;

        if (!data || !data.items) {
            throw new Error('Invalid response structure from Todoist completed tasks API');
        }

        if (data.items.length === 0) {
            const friendlyDate = targetMoment.isSame(moment(), 'day') ? 'today' : targetDateString;
            new Notice(`No tasks completed on ${friendlyDate} found in Todoist.`);
            return ""; // Return empty string if no tasks
        }

        // 3. Group tasks by Project ID
        const tasksByProject = new Map<string | null, TodoistCompletedTask[]>();
        data.items.forEach((task) => {
            const projectId = task.project_id || null;
            if (!tasksByProject.has(projectId)) {
                tasksByProject.set(projectId, []);
            }
            tasksByProject.get(projectId)?.push(task);
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

            projectTasks.forEach((task: TodoistCompletedTask) => {
                const taskId = task.id;
                const taskContent = task.content || `Task ID ${taskId}`;
                const taskUrl = `https://todoist.com/showTask?id=${taskId}`;
                markdownOutput += `- [${taskContent}](${taskUrl})\n`;
            });
            markdownOutput += '\n';
        }

        new Notice(`Inserted ${data.items.length} tasks completed on ${targetDateString}.`);
        return markdownOutput; // Return the formatted string
    }
}

// --- Settings Tab Class ---

class TodoistSettingTab extends PluginSettingTab {
    plugin: TodoistCompletedTasksPlugin;

    constructor(app: App, plugin: TodoistCompletedTasksPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl)
            .setName('Todoist API token')
            .setDesc('Enter your Todoist API token (found in Todoist Settings -> Integrations -> Developer)')
            .addText(text => text
                .setPlaceholder('Enter your token')
                .setValue(this.plugin.settings.todoistApiToken)
                .onChange(async (value) => {
                    this.plugin.settings.todoistApiToken = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Daily Note Date Format')
            .setDesc('File name format for daily notes (e.g., YYYY-MM-DD)')
            .addText(text => text
                .setPlaceholder('Enter date format')
                .setValue(this.plugin.settings.dailyNoteFormat)
                .onChange(async (value) => {
                    this.plugin.settings.dailyNoteFormat = value.trim();
                    await this.plugin.saveSettings();
                }
                ));
    }
}
