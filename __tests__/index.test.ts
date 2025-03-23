import * as fs from 'fs';
import * as path from 'path';
import { jest } from '@jest/globals';

// Mock dependencies
jest.mock('fs', () => {
  const originalModule = jest.requireActual('fs') as typeof fs;
  return {
    ...originalModule,
    promises: {
      readdir: jest.fn(),
      readFile: jest.fn(),
      writeFile: jest.fn(),
      stat: jest.fn(),
    },
    existsSync: jest.fn(),
    statSync: jest.fn(),
    readFileSync: jest.fn(),
  };
});

jest.mock('@ai-sdk/google', () => ({
  google: jest.fn(() => jest.fn()),
}));

jest.mock('ai', () => ({
  streamText: jest.fn(),
}));

jest.mock('ignore', () => {
  return jest.fn().mockReturnValue({
    add: jest.fn().mockReturnThis(),
    ignores: jest.fn().mockReturnValue(false),
  });
});

jest.mock('dotenv', () => ({
  config: jest.fn(),
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

// Helper type for Jest mocks
type MockFunction = jest.Mock<any, any>;

describe('Code Summarizer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      (fs.promises.readdir as jest.Mock).mockImplementation((dir) => {
        if (dir === '/test') return Promise.resolve(mockFiles);
        if (dir === '/test/utils') return Promise.resolve(mockSubFiles);
        return Promise.resolve([]);
      });
      
      (fs.existsSync as jest.Mock).mockReturnValue(false); // No .gitignore
      
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
      
      (fs.promises.readdir as jest.Mock).mockResolvedValue(mockFiles);
      (fs.existsSync as jest.Mock).mockReturnValue(true); // Has .gitignore
      (fs.readFileSync as jest.Mock).mockReturnValue('ignored.js');
      
      // Mock ignore to actually ignore the file
      const mockIgnores = jest.fn().mockImplementation((filePath: string) => filePath.includes('ignored'));
      require('ignore').mockReturnValue({
        add: jest.fn().mockReturnThis(),
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
      
      (fs.promises.readdir as jest.Mock).mockImplementation((dir) => {
        if (dir === '/test') return Promise.resolve(mockFiles);
        return Promise.resolve([]);
      });
      
      (fs.existsSync as jest.Mock).mockReturnValue(false); // No .gitignore
      
      const files = await findCodeFiles('/test');
      
      expect(files).toContain('/test/index.js');
      expect(files.length).toBe(1);
      expect(fs.promises.readdir).toHaveBeenCalledTimes(1); // Didn't scan node_modules
    });
  });

  describe('GeminiLLM', () => {
    it('should respect summary options', async () => {
      // Mock implementation
      const mockedStreamText = streamText as MockFunction;
      mockedStreamText.mockResolvedValue('Mocked summary');
      
      const llm = new GeminiLLM('test-api-key');
      const options: SummaryOptions = {
        detailLevel: 'high',
        maxLength: 1000
      };
      
      await llm.summarize('function test() {}', 'JavaScript', options);
      
      // Check if streamText was called with the right parameters
      expect(mockedStreamText).toHaveBeenCalled();
      const callArg = mockedStreamText.mock.calls[0][0];
      expect(callArg.prompt).toContain('detailed analysis');
      expect(callArg.prompt).toContain('1000 characters');
    });
    
    it('should handle API errors gracefully', async () => {
      const mockedStreamText = streamText as MockFunction;
      mockedStreamText.mockRejectedValue(new Error('API error'));
      
      const llm = new GeminiLLM('test-api-key');
      const result = await llm.summarize('function test() {}', 'JavaScript');
      
      expect(result).toBe('Failed to generate summary.');
    });

    it('should use default options when none provided', async () => {
      const mockedStreamText = streamText as MockFunction;
      mockedStreamText.mockResolvedValue('Default summary');
      
      const llm = new GeminiLLM('test-api-key');
      await llm.summarize('function test() {}', 'JavaScript');
      
      const callArg = mockedStreamText.mock.calls[0][0];
      
      // Should not contain detail level specific text
      expect(callArg.prompt).not.toContain('very brief');
      expect(callArg.prompt).not.toContain('detailed analysis');
      expect(callArg.prompt).toContain('500 characters'); // Default length
    });
  });

  describe('summarizeFile', () => {
    it('should handle files that are too large', async () => {
      (fs.promises.stat as jest.Mock).mockResolvedValue({ size: 1000 * 1024 }); // 1MB
      
      const llm = { summarize: jest.fn() };
      const result = await summarizeFile('/test/big-file.js', '/test', llm as unknown as LLM, 500 * 1024);
      
      expect(llm.summarize).not.toHaveBeenCalled();
      expect(result.summary).toBe('File is too large to summarize.');
    });
    
    it('should summarize files of acceptable size', async () => {
      (fs.promises.stat as jest.Mock).mockResolvedValue({ size: 100 * 1024 }); // 100KB
      (fs.promises.readFile as jest.Mock).mockResolvedValue('const test = 123;');
      
      const llm = { summarize: jest.fn().mockResolvedValue('A simple test file') };
      const result = await summarizeFile('/test/small-file.js', '/test', llm as unknown as LLM);
      
      expect(llm.summarize).toHaveBeenCalledWith('const test = 123;', 'JavaScript', undefined);
      expect(result.summary).toBe('A simple test file');
    });
    
    it('should pass options to LLM', async () => {
      (fs.promises.stat as jest.Mock).mockResolvedValue({ size: 100 * 1024 });
      (fs.promises.readFile as jest.Mock).mockResolvedValue('const test = 123;');
      
      const options: SummaryOptions = {
        detailLevel: 'low',
        maxLength: 200
      };
      
      const llm = { summarize: jest.fn().mockResolvedValue('A simple test file') };
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
      const mockSummarizeFile = jest.fn((filePath: string) => {
        return Promise.resolve({
          relativePath: path.relative('/test', filePath),
          summary: `Summary of ${path.basename(filePath)}`
        });
      });
      
      // Apply the mock
      jest.spyOn(global, 'summarizeFile' as any).mockImplementation(mockSummarizeFile);
      
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