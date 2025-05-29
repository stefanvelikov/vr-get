const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs').promises;
const path = require('path');
const { JSDOM } = require('jsdom');

// Configuration
const processingDomain = 'https://vr-partners-staging.webflow.io';
const sitemapRealDomain = 'https://vr-partners.eu';
const sitemapUrl = `${processingDomain}/sitemap.xml`;
const outputFolder = 'website';
const sitemapFileName = 'sitemap.xml';

// Utility Functions
async function clearFolder(folderPath, excludeFiles = []) {
  try {
    const files = await fs.readdir(folderPath);
    for (const file of files) {
      if (!excludeFiles.includes(file)) {
        const filePath = path.join(folderPath, file);
        if (await isDirectory(filePath)) {
          await clearFolder(filePath, excludeFiles);
          await fs.rmdir(filePath);
        } else {
          await fs.unlink(filePath);
        }
      }
    }
  } catch (error) {
    console.error(`Error clearing folder ${folderPath}:`, error.message);
  }
}

async function isDirectory(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// Core Functions
async function fetchSitemap() {
  try {
    await clearFolder(outputFolder, ['.htaccess', 'robots.txt', sitemapFileName]);
    const response = await axios.get(sitemapUrl);

    const parser = new xml2js.Parser();
    const sitemapObj = await parser.parseStringPromise(response.data);

    const urls = sitemapObj.urlset.url.map(url => ({
      loc: [url.loc[0].trim().replace(processingDomain, processingDomain)],
    }));

    await fs.mkdir(outputFolder, { recursive: true });

    const updatedSitemapXml = new xml2js.Builder().buildObject({
      ...sitemapObj,
      urlset: { ...sitemapObj.urlset, url: urls },
    });

    const sitemapFilePath = path.join(outputFolder, sitemapFileName);
    await fs.writeFile(sitemapFilePath, updatedSitemapXml);

    console.log(`Updated sitemap saved to ${sitemapFilePath}`);

    for (const url of urls) {
      await fetchAndSaveContent(url.loc[0]);
    }
  } catch (error) {
    console.error('Error fetching or processing sitemap:', error.message);
  }
}

async function fetchAndSaveContent(url, createFoldersFor = []) {
  try {
    const response = await axios.get(url);
    const dom = new JSDOM(response.data);
    const hasFormTag = dom.window.document.querySelector('form');

    let cleanedContent = response.data;
    if (!hasFormTag) {
      cleanedContent = cleanedContent
        .replace(/data-wf-domain="[^"]*"/g, '')
        .replace(/data-wf-page="[^"]*"/g, '')
        .replace(/data-wf-site="[^"]*"/g, '');
    }

    const parsedUrl = new URL(url);
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);

    // Only create folders for specific paths
    if (createFoldersFor.some(path => parsedUrl.pathname.startsWith(path))) {
      let currentFolderPath = outputFolder;
      for (let i = 0; i < pathSegments.length - 1; i++) {
        currentFolderPath = path.join(currentFolderPath, pathSegments[i]);
        await fs.mkdir(currentFolderPath, { recursive: true });
      }
    }

    const fileName = pathSegments.length > 0 ? `${pathSegments.pop()}.html` : 'index.html';
    const filePath = path.join(outputFolder, ...pathSegments, fileName);
    await fs.writeFile(filePath, cleanedContent);

    console.log(`Content for ${url} fetched and saved to ${filePath}`);
  } catch (error) {
    console.error(`Error fetching content for ${url}:`, error.message);
  }
}

async function fetchResourceLinksAndUpdateSitemap(pagePath = '/resources', createFoldersFor = []) {
  const pageUrl = `${processingDomain}${pagePath}`;

  try {
    const response = await axios.get(pageUrl);
    const dom = new JSDOM(response.data);

    const linkElements = dom.window.document.querySelectorAll('a[href]');
    const internalLinks = Array.from(linkElements)
      .map(el => el.getAttribute('href'))
      .filter(href => href.startsWith('/') && !href.startsWith('//')); // Only relative internal links

    console.log(`Found internal links on ${pagePath}:`, internalLinks);

    const sitemapFilePath = path.join(outputFolder, sitemapFileName);
    const sitemapData = await fs.readFile(sitemapFilePath, 'utf-8');
    const parser = new xml2js.Parser();
    const sitemapObj = await parser.parseStringPromise(sitemapData);

    internalLinks.forEach(link => {
      const fullUrl = `${processingDomain}${link}`;
      if (!sitemapObj.urlset.url.some(urlObj => urlObj.loc[0] === fullUrl)) {
        sitemapObj.urlset.url.push({ loc: [fullUrl] });
        console.log(`Adding ${fullUrl} to sitemap.`);
      }
    });

    const updatedSitemapXml = new xml2js.Builder().buildObject(sitemapObj);
    await fs.writeFile(sitemapFilePath, updatedSitemapXml);

    console.log(`Updated sitemap with internal links from ${pagePath} saved to ${sitemapFilePath}`);

    for (const link of internalLinks) {
      await fetchAndSaveContent(`${processingDomain}${link}`, createFoldersFor);
    }
  } catch (error) {
    console.error(`Error fetching or processing page ${pagePath}:`, error.message);
  }
}


async function fixSitemapDomains() {
  try {
    const sitemapFilePath = path.join(outputFolder, sitemapFileName);
    const sitemapData = await fs.readFile(sitemapFilePath, 'utf-8');

    const sitemapObj = await new xml2js.Parser().parseStringPromise(sitemapData);

    // Define arrays for inclusion and exclusion
    const pathsToEnsureSlash = [
      '/resources'
    ];
    const pathsToExclude = [
    ];

    sitemapObj.urlset.url = sitemapObj.urlset.url.filter(urlObj => {
      // Extract the path from the URL
      const urlPath = new URL(urlObj.loc[0]).pathname;

      // Exclude URLs that match any path in the exclusion array exactly
      const shouldExclude = pathsToExclude.includes(urlPath);
      return !shouldExclude;
    });

    sitemapObj.urlset.url.forEach(urlObj => {
      // Replace domain as per existing logic
      urlObj.loc[0] = urlObj.loc[0].replace(processingDomain, sitemapRealDomain);

      // Ensure URLs in the inclusion list have a trailing slash
      const urlPath = new URL(urlObj.loc[0]).pathname;
      if (pathsToEnsureSlash.includes(urlPath) && !urlObj.loc[0].endsWith('/')) {
        urlObj.loc[0] += '/';
      }
    });

    const updatedSitemapXml = new xml2js.Builder().buildObject(sitemapObj);
    await fs.writeFile(sitemapFilePath, updatedSitemapXml);

    console.log(`Sitemap domains fixed and saved to ${sitemapFilePath}`);
  } catch (error) {
    console.error('Error fixing sitemap domains:', error.message);
  }
}



async function moveAndRenameResourcesFile(outputFolder, fileName, folderName) {
  const sourceFile = path.join(outputFolder, fileName);
  const destinationFolder = path.join(outputFolder, folderName);
  const destinationFile = path.join(destinationFolder, 'index.html');

  try {
    await fs.mkdir(destinationFolder, { recursive: true });
    await fs.rename(sourceFile, destinationFile);
    console.log(`Moved and renamed ${fileName} to ${destinationFile}`);
  } catch (error) {
    console.error(`Error moving and renaming ${fileName}: ${error.message}`);
  }
}

async function removeExactUrlsFromSitemap(urlsToRemove) {
  try {
    const sitemapFilePath = path.join(outputFolder, sitemapFileName);
    const sitemapData = await fs.readFile(sitemapFilePath, 'utf-8');

    const sitemapObj = await new xml2js.Parser().parseStringPromise(sitemapData);

    // Normalize URLs to ensure exact matching
    const normalizedUrlsToRemove = urlsToRemove.map(url => new URL(url).toString());

    // Filter out URLs that match exactly in the normalized list
    sitemapObj.urlset.url = sitemapObj.urlset.url.filter(urlObj => {
      const loc = new URL(urlObj.loc[0]).toString(); // Normalize each URL in the sitemap
      return !normalizedUrlsToRemove.includes(loc);
    });

    // Convert the updated object back to XML
    const updatedSitemapXml = new xml2js.Builder().buildObject(sitemapObj);
    await fs.writeFile(sitemapFilePath, updatedSitemapXml);

    console.log(`Exact URLs removed and updated sitemap saved to ${sitemapFilePath}`);
  } catch (error) {
    console.error('Error removing exact URLs from sitemap:', error.message);
  }
}


async function addLinksToSitemapAtTop(linksToAdd) {
  try {
    const sitemapFilePath = path.join(outputFolder, sitemapFileName);
    const sitemapData = await fs.readFile(sitemapFilePath, 'utf-8');

    const parser = new xml2js.Parser();
    const sitemapObj = await parser.parseStringPromise(sitemapData);

    // Ensure the new links are normalized and formatted
    const normalizedLinksToAdd = linksToAdd.map(link => ({
      loc: [link.replace(/\/$/, '')], // Remove trailing slash
    }));

    // Add new links to the top of the array, avoiding duplicates
    sitemapObj.urlset.url = [
      ...normalizedLinksToAdd.filter(
        linkObj => !sitemapObj.urlset.url.some(urlObj => urlObj.loc[0] === linkObj.loc[0])
      ),
      ...sitemapObj.urlset.url,
    ];

    // Build the updated sitemap with proper XML declaration and namespaces
    const builder = new xml2js.Builder({
      headless: false, // Ensure the XML declaration is included
    });

    const namespaces = {
      $: {
        xmlns: 'http://www.sitemaps.org/schemas/sitemap/0.9',
        'xmlns:xhtml': 'http://www.w3.org/1999/xhtml',
      },
    };

    const updatedSitemapXml = builder.buildObject({
      urlset: {
        ...namespaces,
        url: sitemapObj.urlset.url,
      },
    });

    // Write the updated sitemap to file
    await fs.writeFile(sitemapFilePath, updatedSitemapXml);

    console.log(`Links added at the top of the sitemap and saved to ${sitemapFilePath}`);
  } catch (error) {
    console.error('Error updating sitemap:', error.message);
  }
}

// Example usage
const newLinks = [
];





const urlsToRemove = [
  'https://vr-partners.eu/#our-services',
  'https://vr-partners.eu/#about-us'
];


// Main Process
async function processSitemapAndResources() {
  await fetchSitemap();
  await fetchResourceLinksAndUpdateSitemap('/resources', ['/resources']);
  moveAndRenameResourcesFile(outputFolder, 'resources.html', 'resources');

  await fixSitemapDomains();
  await removeExactUrlsFromSitemap(urlsToRemove);
  await addLinksToSitemapAtTop(newLinks);
  await moveAndRenameResourcesFile();
}

processSitemapAndResources();
