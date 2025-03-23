// index.ts
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import ignore from 'ignore';
import { Command } from 'commander';

// Load environment variables
dotenv.config();

// Interface for summary options
interface SummaryOptions {
  detailLevel: 'low' | 'medium' | 'high';
  maxLength: number; // Maximum length in characters
}

// Interface for LLM implementations
interface LLM {
  summarize(code: string, language: string, options?: SummaryOptions): Promise<string>;
}

// Gemini Flash 2.0 implementation
class GeminiLLM implements LLM {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async summarize(code: string, language: string, options?: SummaryOptions): Promise<string> {
    try {
      // Default options
      const summaryOptions: SummaryOptions = {
        detailLevel: options?.detailLevel || 'medium',
        maxLength: options?.maxLength || 500
      };
      
      // Customize prompt based on detail level
      let detailPrompt = '';
      if (summaryOptions.detailLevel === 'low') {
        detailPrompt = 'Keep it very brief, focusing only on the main purpose.';
      } else if (summaryOptions.detailLevel === 'high') {
        detailPrompt = 'Provide a detailed analysis including functions, methods, and how they interact.';
      }
      
      const prompt = `Provide an overview summary of the code in this ${language} file.
${detailPrompt}
Keep the summary under ${summaryOptions.maxLength} characters.

${code}`;
      
      const result = await generateText({
        model: google('gemini-2.0-flash-exp'),
        prompt
      });

      return result;
    } catch (error) {
      console.error(`Error summarizing with Gemini: ${error instanceof Error ? error.message : String(error)}`);
      return "Failed to generate summary.";
    }
  }
}

// Map file extensions to language names
const extensionToLanguage: Record<string, string> = {
  '.ts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript (React)',
  '.tsx': 'TypeScript (React)',
  '.py': 'Python',
  '.java': 'Java',
  '.cpp': 'C++',
  '.c': 'C',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.rs': 'Rust',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.vue': 'Vue.js',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.less': 'Less',
};

// Always skip these directories
const skipDirectories = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  'bin',
  'obj',
  'target',
  'vendor',
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
]);

// Find all code files in a directory
async function findCodeFiles(rootDir: string): Promise<string[]> {
  // Check if .gitignore exists
  let gitignoreFilter: ReturnType<typeof ignore> | null = null;
  const gitignorePath = path.join(rootDir, '.gitignore');
  
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    gitignoreFilter = ignore().add(gitignoreContent);
  }
  
  const allFiles: string[] = [];
  
  // Recursive function to scan directories
  async function scanDirectory(dir: string): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      
      // Skip if matched by .gitignore
      if (gitignoreFilter && gitignoreFilter.ignores(relativePath)) {
        continue;
      }
      
      if (entry.isDirectory()) {
        // Skip directories in the skip list
        if (skipDirectories.has(entry.name)) {
          continue;
        }
        
        // Recursively scan subdirectories
        await scanDirectory(fullPath);
      } else if (entry.isFile()) {
        // Check if the file has a supported extension
        const ext = path.extname(entry.name).toLowerCase();
        if (ext in extensionToLanguage) {
          allFiles.push(fullPath);
        }
      }
    }
  }
  
  await scanDirectory(rootDir);
  return allFiles;
}

// Interface for file summary
interface FileSummary {
  relativePath: string;
  summary: string;
}

// Summarize a single file
async function summarizeFile(
  filePath: string, 
  rootDir: string, 
  llm: LLM,
  maxFileSizeBytes: number = 500 * 1024, // Default to 500KB as a reasonable limit
  options?: SummaryOptions
): Promise<FileSummary> {
  try {
    // Check file size first
    const stats = await fs.promises.stat(filePath);
    if (stats.size > maxFileSizeBytes) {
      console.warn(`File ${filePath} is too large (${(stats.size / 1024).toFixed(2)}KB). Skipping.`);
      return {
        relativePath: path.relative(rootDir, filePath),
        summary: "File is too large to summarize."
      };
    }

    const fileContent = await fs.promises.readFile(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();
    const language = extensionToLanguage[ext] || ext.slice(1); // Use mapped language or extension without dot
    
    const summary = await llm.summarize(fileContent, language, options);
    const relativePath = path.relative(rootDir, filePath);
    
    return {
      relativePath,
      summary
    };
  } catch (error) {
    console.error(`Error processing file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return {
      relativePath: path.relative(rootDir, filePath),
      summary: "Failed to summarize this file."
    };
  }
}

// Summarize multiple files in batches
async function summarizeFiles(
  filePaths: string[],
  rootDir: string,
  llm: LLM,
  batchSize: number = 5, // Process in batches to avoid overwhelming the LLM API
  options?: SummaryOptions
): Promise<FileSummary[]> {
  const allSummaries: FileSummary[] = [];
  
  // Process files in batches
  for (let i = 0; i < filePaths.length; i += batchSize) {
    const batch = filePaths.slice(i, i + batchSize);
    
    console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(filePaths.length / batchSize)} (${i + 1}-${Math.min(i + batchSize, filePaths.length)} of ${filePaths.length} files)`);
    
    const batchPromises = batch.map(filePath => {
      console.log(`  Summarizing: ${path.relative(rootDir, filePath)}`);
      return summarizeFile(filePath, rootDir, llm, 500 * 1024, options);
    });
    
    const batchResults = await Promise.all(batchPromises);
    allSummaries.push(...batchResults);
  }
  
  return allSummaries;
}

// Write summaries to output file
async function writeSummariesToFile(
  summaries: FileSummary[],
  outputPath: string
): Promise<void> {
  const content = summaries
    .map(summary => `${summary.relativePath}\n${summary.summary}\n`)
    .join('\n');
  
  await fs.promises.writeFile(outputPath, content, 'utf-8');
  console.log(`Summaries written to ${outputPath}`);
}

// Main function
async function main() {
  try {
    const program = new Command();
    
    program
      .name('code-summarizer')
      .description('A tool to summarize code files using Gemini Flash 2.0')
      .argument('[rootDir]', 'Root directory to scan', process.cwd())
      .argument('[outputFile]', 'Output file for summaries', 'summaries.txt')
      .option('-d, --detail <level>', 'Detail level (low, medium, high)', 'medium')
      .option('-l, --max-length <number>', 'Maximum summary length in characters', '500')
      .helpOption('-h, --help', 'Display help information')
      .parse(process.argv);

    const options = program.opts();
    const [rootDir, outputFile] = program.processedArgs;
    
    // Validate detail level
    if (!['low', 'medium', 'high'].includes(options.detail)) {
      throw new Error(`Invalid detail level: ${options.detail}. Use 'low', 'medium', or 'high'.`);
    }

    // Validate max length
    const maxLength = parseInt(options.maxLength);
    if (isNaN(maxLength) || maxLength <= 0) {
      throw new Error(`Invalid max length: ${options.maxLength}. Use a positive number.`);
    }

    // Validate the root directory
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      throw new Error(`Invalid directory: ${rootDir}`);
    }
    
    console.log(`Scanning directory: ${rootDir}`);
    console.log(`Output file: ${outputFile}`);
    console.log(`Detail level: ${options.detail}`);
    console.log(`Max length: ${maxLength}`);
    
    // Check if API key is available
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY is not set in .env file');
    }
    
    // Initialize the LLM
    const llm = new GeminiLLM(apiKey);
    
    // Find all code files
    console.log('Finding code files...');
    const codeFiles = await findCodeFiles(rootDir);
    console.log(`Found ${codeFiles.length} code files to process`);
    
    if (codeFiles.length === 0) {
      console.log('No code files found to summarize.');
      return;
    }
    
    // Create summary options
    const summaryOptions: SummaryOptions = {
      detailLevel: options.detail as 'low' | 'medium' | 'high',
      maxLength: maxLength
    };
    
    // Summarize the files
    console.log('Generating summaries...');
    const summaries = await summarizeFiles(codeFiles, rootDir, llm, 5, summaryOptions);
    
    // Write summaries to the output file
    await writeSummariesToFile(summaries, outputFile);
    
    console.log('Code summarization completed successfully!');
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Export for testing
export {
  findCodeFiles,
  summarizeFile,
  summarizeFiles,
  writeSummariesToFile,
  GeminiLLM,
  SummaryOptions,
  extensionToLanguage,
  skipDirectories,
  LLM,
  FileSummary
};

// Only run main when file is executed directly, not when imported
if (require.main === module) {
  main();
}