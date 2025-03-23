import * as path from 'path';
import * as fs from 'fs';
import { jest } from '@jest/globals';
import { findCodeFiles, GeminiLLM, summarizeFiles, SummaryOptions } from '../index';

// Only mock the generateText function, not the actual file system operations
jest.mock('ai', () => ({
  generateText: jest.fn().mockImplementation(() => Promise.resolve('Mocked summary for testing'))
}));

jest.mock('@ai-sdk/google', () => ({
  google: jest.fn().mockReturnValue(jest.fn())
}));

// This test uses actual file operations on the mock codebase
describe('Mock Codebase Integration Tests', () => {
  const mockCodebasePath = path.join(__dirname, '..', '__mocks__', 'mock-codebase');
  
  beforeAll(() => {
    // Ensure the mock codebase exists
    if (!fs.existsSync(mockCodebasePath)) {
      throw new Error(`Mock codebase not found at ${mockCodebasePath}`);
    }
    
    // Set environment variable for testing
    process.env.GOOGLE_API_KEY = 'test-api-key';
  });
  
  it('should find all code files in the mock codebase', async () => {
    const files = await findCodeFiles(mockCodebasePath);
    
    // Should find the JavaScript files
    expect(files).toContain(path.join(mockCodebasePath, 'src', 'index.js'));
    expect(files).toContain(path.join(mockCodebasePath, 'src', 'utils', 'helpers.js'));
    expect(files).toContain(path.join(mockCodebasePath, 'tests', 'test.js'));
    
    // Should not include the README.md or .gitignore
    const filePaths = files.map(file => path.basename(file));
    expect(filePaths).not.toContain('README.md');
    expect(filePaths).not.toContain('.gitignore');
  });
  
  it('should summarize files with different detail levels', async () => {
    // Only test with a couple of files to keep the test fast
    const testFiles = [
      path.join(mockCodebasePath, 'src', 'index.js'),
      path.join(mockCodebasePath, 'src', 'utils', 'helpers.js')
    ];
    
    const llm = new GeminiLLM('test-api-key');
    
    // Test with low detail level
    const lowDetailOptions: SummaryOptions = {
      detailLevel: 'low',
      maxLength: 100
    };
    
    const lowDetailSummaries = await summarizeFiles(testFiles, mockCodebasePath, llm, 2, lowDetailOptions);
    
    expect(lowDetailSummaries.length).toBe(2);
    expect(lowDetailSummaries[0].relativePath).toBe(path.relative(mockCodebasePath, testFiles[0]));
    expect(lowDetailSummaries[0].summary).toBe('Mocked summary for testing');
    
    // Test with high detail level
    const highDetailOptions: SummaryOptions = {
      detailLevel: 'high',
      maxLength: 1000
    };
    
    const highDetailSummaries = await summarizeFiles(testFiles, mockCodebasePath, llm, 2, highDetailOptions);
    
    expect(highDetailSummaries.length).toBe(2);
    expect(highDetailSummaries[0].summary).toBe('Mocked summary for testing');
    
    // Verify the options were passed correctly
    const { generateText } = require('ai');
    const mockCalls = generateText.mock.calls;
    
    // Find calls that include specific detail levels in their prompts
    const lowDetailCall = mockCalls.find((call: any) => 
      call[0]?.prompt?.includes('Keep it very brief')
    );
    
    const highDetailCall = mockCalls.find((call: any) => 
      call[0]?.prompt?.includes('detailed analysis')
    );
    
    expect(lowDetailCall).toBeTruthy();
    expect(highDetailCall).toBeTruthy();
    
    if (lowDetailCall) {
      expect(lowDetailCall[0].prompt).toContain('100 characters');
    }
    
    if (highDetailCall) {
      expect(highDetailCall[0].prompt).toContain('1000 characters');
    }
  });
});