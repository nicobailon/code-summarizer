import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock dependencies
vi.mock('fs', () => {
  const originalModule = vi.importActual('fs') as typeof fs;
  return {
    ...originalModule,
    promises: {
      readdir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      stat: vi.fn(),
    },
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock('@ai-sdk/google', () => ({
  google: vi.fn(() => vi.fn()),
}));

vi.mock('ai', () => ({
  streamText: vi.fn(),
}));

vi.mock('ignore', () => {
  return vi.fn().mockReturnValue({
    add: vi.fn().mockReturnThis(),
    ignores: vi.fn().mockReturnValue(false),
  });
});

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

// Import after mocking
import { 
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
} from '../index';
import { streamText } from 'ai';

describe('Code Summarizer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.GOOGLE_API_KEY = 'test-api-key';
  });

  describe('findCodeFiles', () => {
    it('should find code files in a directory', async () => {
      // Mock implementation
      const mockFiles = [
        { name: 'index.js', isDirectory: () => false, isFile: () => true },
        { name: 'utils', isDirectory: () => true, isFile: () => false },
      ];
      
      const mockSubFiles = [
        { name: 'helpers.js', isDirectory: () => false, isFile: () => true },
      ];
      
      // Mock fs methods
      (fs.promises.readdir as any).mockImplementation((dir) => {
        if (dir === '/test') return Promise.resolve(mockFiles);
        if (dir === '/test/utils') return Promise.resolve(mockSubFiles);
        return Promise.resolve([]);
      });
      
      (fs.existsSync as any).mockReturnValue(false); // No .gitignore
      
      const files = await findCodeFiles('/test');
      
      expect(files).toContain('/test/index.js');
      expect(files).toContain('/test/utils/helpers.js');
      expect(files.length).toBe(2);
    });
    
    it('should respect gitignore rules', async () => {
      const mockFiles = [
        { name: 'index.js', isDirectory: () => false, isFile: () => true },
        { name: 'ignored.js', isDirectory: () => false, isFile: () => true },
      ];
      
      (fs.promises.readdir as any).mockResolvedValue(mockFiles);
      (fs.existsSync as any).mockReturnValue(true); // Has .gitignore
      (fs.readFileSync as any).mockReturnValue('ignored.js');
      
      // Mock ignore to actually ignore the file
      const mockIgnores = vi.fn((filePath: string) => filePath.includes('ignored'));
      require('ignore').mockReturnValue({
        add: vi.fn().mockReturnThis(),
        ignores: mockIgnores,
      });
      
      const files = await findCodeFiles('/test');
      
      expect(files).toContain('/test/index.js');
      expect(files).not.toContain('/test/ignored.js');
      expect(files.length).toBe(1);
    });
    
    it('should skip directories in the skip list', async () => {
      const mockFiles = [
        { name: 'index.js', isDirectory: () => false, isFile: () => true },
        { name: 'node_modules', isDirectory: () => true, isFile: () => false },
      ];
      
      (fs.promises.readdir as any).mockImplementation((dir) => {
        if (dir === '/test') return Promise.resolve(mockFiles);
        return Promise.resolve([]);
      });
      
      (fs.existsSync as any).mockReturnValue(false); // No .gitignore
      
      const files = await findCodeFiles('/test');
      
      expect(files).toContain('/test/index.js');
      expect(files.length).toBe(1);
      expect(fs.promises.readdir).toHaveBeenCalledTimes(1); // Didn't scan node_modules
    });
  });

  describe('GeminiLLM', () => {
    it('should respect summary options', async () => {
      // Mock implementation
      (streamText as any).mockResolvedValue('Mocked summary');
      
      const llm = new GeminiLLM('test-api-key');
      const options: SummaryOptions = {
        detailLevel: 'high',
        maxLength: 1000
      };
      
      await llm.summarize('function test() {}', 'JavaScript', options);
      
      // Check if streamText was called with the right parameters
      expect(streamText).toHaveBeenCalled();
      const callArg = (streamText as any).mock.calls[0][0];
      expect(callArg.prompt).toContain('detailed analysis');
      expect(callArg.prompt).toContain('1000 characters');
    });
    
    it('should handle API errors gracefully', async () => {
      (streamText as any).mockRejectedValue(new Error('API error'));
      
      const llm = new GeminiLLM('test-api-key');
      const result = await llm.summarize('function test() {}', 'JavaScript');
      
      expect(result).toBe('Failed to generate summary.');
    });

    it('should use default options when none provided', async () => {
      (streamText as any).mockResolvedValue('Default summary');
      
      const llm = new GeminiLLM('test-api-key');
      await llm.summarize('function test() {}', 'JavaScript');
      
      const callArg = (streamText as any).mock.calls[0][0];
      
      // Should not contain detail level specific text
      expect(callArg.prompt).not.toContain('very brief');
      expect(callArg.prompt).not.toContain('detailed analysis');
      expect(callArg.prompt).toContain('500 characters'); // Default length
    });
  });

  describe('summarizeFile', () => {
    it('should handle files that are too large', async () => {
      (fs.promises.stat as any).mockResolvedValue({ size: 1000 * 1024 }); // 1MB
      
      const llm = { summarize: vi.fn() };
      const result = await summarizeFile('/test/big-file.js', '/test', llm as unknown as LLM, 500 * 1024);
      
      expect(llm.summarize).not.toHaveBeenCalled();
      expect(result.summary).toBe('File is too large to summarize.');
    });
    
    it('should summarize files of acceptable size', async () => {
      (fs.promises.stat as any).mockResolvedValue({ size: 100 * 1024 }); // 100KB
      (fs.promises.readFile as any).mockResolvedValue('const test = 123;');
      
      const llm = { summarize: vi.fn().mockResolvedValue('A simple test file') };
      const result = await summarizeFile('/test/small-file.js', '/test', llm as unknown as LLM);
      
      expect(llm.summarize).toHaveBeenCalledWith('const test = 123;', 'JavaScript', undefined);
      expect(result.summary).toBe('A simple test file');
    });
    
    it('should pass options to LLM', async () => {
      (fs.promises.stat as any).mockResolvedValue({ size: 100 * 1024 });
      (fs.promises.readFile as any).mockResolvedValue('const test = 123;');
      
      const options: SummaryOptions = {
        detailLevel: 'low',
        maxLength: 200
      };
      
      const llm = { summarize: vi.fn().mockResolvedValue('A simple test file') };
      await summarizeFile('/test/small-file.js', '/test', llm as unknown as LLM, 500 * 1024, options);
      
      expect(llm.summarize).toHaveBeenCalledWith('const test = 123;', 'JavaScript', options);
    });
  });

  describe('summarizeFiles', () => {
    it('should process files in batches', async () => {
      const mockFilePaths = [
        '/test/file1.js',
        '/test/file2.js',
        '/test/file3.js',
        '/test/file4.js',
        '/test/file5.js',
        '/test/file6.js',
      ];
      
      // Mock summarizeFile to return a predictable result
      const mockSummarizeFile = vi.fn((filePath: string) => {
        return Promise.resolve({
          relativePath: path.relative('/test', filePath),
          summary: `Summary of ${path.basename(filePath)}`
        });
      });
      
      // Apply the mock
      vi.spyOn(global as any, 'summarizeFile').mockImplementation(mockSummarizeFile);
      
      const llm = new GeminiLLM('test-api-key');
      const result = await summarizeFiles(mockFilePaths, '/test', llm, 2); // Batch size of 2
      
      expect(result.length).toBe(6);
      expect(result[0].relativePath).toBe('file1.js');
      expect(result[0].summary).toBe('Summary of file1.js');
      
      // Should have processed in 3 batches (for 6 files with batch size 2)
      expect(mockSummarizeFile).toHaveBeenCalledTimes(6);
    });
  });

  describe('writeSummariesToFile', () => {
    it('should write summaries in the correct format', async () => {
      const mockSummaries = [
        { relativePath: 'file1.js', summary: 'Summary of file1.js' },
        { relativePath: 'file2.js', summary: 'Summary of file2.js' },
      ];
      
      await writeSummariesToFile(mockSummaries, '/test/output.txt');
      
      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        '/test/output.txt',
        'file1.js\nSummary of file1.js\n\nfile2.js\nSummary of file2.js\n',
        'utf-8'
      );
    });
  });
});
