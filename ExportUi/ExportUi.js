function downloadBlob(data, fileName, mimeType) {
  var blob, url;
  blob = new Blob([data], {
    type: mimeType
  });
  url = window.URL.createObjectURL(blob);
  downloadURL(url, fileName);
  setTimeout(function() {
    return window.URL.revokeObjectURL(url);
  }, 1000);
};

function downloadURL(data, fileName) {
  var a;
  a = document.createElement('a');
  a.href = data;
  a.download = fileName;
  document.body.appendChild(a);
  a.style = 'display: none';
  a.click();
  a.remove();
};

async function copyPivotStatementToClipboard(){
  try {
    var sql = getDuckDbPivotSqlStatementForQueryModel(queryModel);
    await copyToClipboard(sql, 'text/plain');
  }
  catch (e){
    showErrorDialog(e);
  }
}

async function downloadPivotStatementToSqlFile(){
  // todo: make the filename configurable through settings
  // todo: generate a reasonable filename based on the query
  var fileName = 'pivot.sql';
  var sql = getDuckDbPivotSqlStatementForQueryModel(queryModel);
  downloadBlob(sql, fileName, 'text/plain');
}

async function downloadQueryResultToCsvFile(){
  // todo: generate a reasonable default filename based on the query
  // todo: make the filename configurable through settings
  // todo: make the default csv options configurable through settings
  // todo: make the currenmt csv options configurable in the dialog
  var fileName = 'huey-results.csv';
  var sql = getDuckDbPivotSqlStatementForQueryModel(queryModel);
  //see: https://github.com/holdenmatt/duckdb-wasm-kit/blob/main/src/files/exportFile.ts#L31-L49
  await window.hueyDb.connection.query(`copy (${sql}) to \'${fileName}\' WITH (HEADER 1, DELIMITER \';\')`);
  var buffer = await window.hueyDb.instance.copyFileToBuffer(fileName);
  window.hueyDb.instance.dropFile(fileName);
  var results = new TextDecoder('utf-8').decode(buffer);
  downloadBlob(results, fileName, 'text/csv');
}

async function downloadQueryResultToParquetFile(){
  // todo: generate a reasonable default filename based on the query
  // todo: make the filename configurable through settings
  // todo: make the default parquet options configurable through settings
  // todo: make the currennt parquet options configurable in the dialog
  var fileName = 'huey-results.parquet';
  var sql = getDuckDbPivotSqlStatementForQueryModel(queryModel);
  //see: https://github.com/holdenmatt/duckdb-wasm-kit/blob/main/src/files/exportFile.ts#L31-L49
  await window.hueyDb.connection.query(`copy (${sql}) to \'${fileName}\' (FORMAT PARQUET, COMPRESSION GZIP)`);
  var buffer = await window.hueyDb.instance.copyFileToBuffer(fileName);
  window.hueyDb.instance.dropFile(fileName);
  // see: https://github.com/holdenmatt/duckdb-wasm-kit/blob/main/src/files/parquet.ts
  downloadBlob(buffer, fileName, 'application/vnd.apache.parquet');
}

function initExportUi(){
  // open the export ui dialog
  byId('downloadButton')
  .addEventListener('click', function(){
    byId('exportDialog').showModal();
  });

  // close the export ui dialog
  byId('exportDialogCloseButton')
  .addEventListener('click', function(){
    byId('exportDialog').close();
  });
  
  // export dialog actions:
  
  // copy sql to clipboard
  byId('copyPivotStatementToClipboard')
  .addEventListener('click', function(){
    copyPivotStatementToClipboard();
  });

  // download sql file
  byId('downloadPivotStatementToSqlFile')
  .addEventListener('click', function(){
    downloadPivotStatementToSqlFile();
  });
 
  // download results as CSV file
  byId('downloadQueryResultsAsCsvFile')
  .addEventListener('click', function(){
    downloadQueryResultToCsvFile();
  });
  
  // download results as parquet file
  byId('downloadQueryResultsAsParquetFile')
  .addEventListener('click', function(){
    downloadQueryResultToParquetFile();
  });
}