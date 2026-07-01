# CucumberStudio Export Script

This script automatically downloads all `.feature` files from a project in CucumberStudio and reconstructs the exact folder hierarchy on your local machine.

## Prerequisites

1. **Node.js**: Ensure you have Node.js installed on your machine (v18 or higher is recommended). You can verify this by running `node -v` in your terminal. If you don't have it, download it from [nodejs.org](https://nodejs.org/).
2. **Account Access**: You must have an active CucumberStudio account with read access to the project you want to export.

## Setup Instructions

1. **Locate the files**: Make sure both `export-features.mjs` and `.env.example` are placed together in the same folder on your computer.
2. **Find your Project ID**: 
   - Log into [CucumberStudio](https://studio.cucumberstudio.com/).
   - Open the project you want to export.
   - Look at the URL in your browser. It will look something like this: `https://studio.cucumberstudio.com/projects/123456/...`
   - The number directly after `/projects/` is your **Project ID** (in this example, it would be `123456`).
3. **Configure the `.env` file**: 
   - Rename or copy the `.env.example` file to `.env`.
   - Open the new `.env` file in any text editor and fill in your CucumberStudio credentials and the Project ID you just found:
   ```env
   EMAIL=your_actual_email@example.com
   PASSWORD=your_actual_password
   PROJECT_ID=123456
   ```
   *(Note: Do not put quotes around the values).*

## Running the Script

1. Open your terminal (Mac/Linux) or Command Prompt/PowerShell (Windows).
2. Navigate to the folder where you placed the script:
   ```bash
   cd path/to/the/folder
   ```
3. Run the script using Node:
   ```bash
   node export-features.mjs
   ```

## What to Expect

- The script will log in securely and map out the folder structure of your project.
- It will create a new folder named `features/` in your current directory.
- Inside the `features/` folder, it will recreate the exact folder tree from CucumberStudio and save the downloaded Gherkin content as `.feature` files.
- You can watch the progress in your terminal, which will summarize how many files were successfully downloaded and if any empty folders were created.
