class CellSet {
    
  #queryModel = undefined;
  
  // Cells is an array indexed by columntupleIndex * rowTupleIndex
  // Cells array elements are objects having a values property.
  // The values property is an array of values corresponding (by position) to the items of the cells axis
  #cells = [];
  #cellValueFields = {};
  
  #tupleSets = [];
    
  constructor(queryModel, tupleSets){
    this.#queryModel = queryModel;
    this.#tupleSets = tupleSets;
  }

  #getSqlSelectStatement(){
    return '';
  }
  
  clear(){
    this.#cells = [];
    this.#cellValueFields = {};
  }  

  getCellValueFields(){
    return this.#cellValueFields;
  }

  // variable argument list,
  // each argument should be a tuple index
  // tuple indexes should by in order of tupleSets
  getCellIndex(){
    var cellIndex = 0;
    var tupleSets = this.#tupleSets;
    var numTupleSets = tupleSets.length || 0;
    
    // for each tupleset ...
    for (var i = 0; i < numTupleSets; i++){
      var tupleIndex = arguments[i];
      var factor = tupleIndex;
      // ...get the factor for all downstream tuplesets.
      for (var j = i + 1; j < numTupleSets; j++){
        var tupleSet = tupleSets[j];
        var numTuples = tupleSet.getTupleCountSync();
        if (!numTuples) {
          continue;
        }
        factor *= numTuples;
      }
      cellIndex += factor;
    }
    return cellIndex;
  }
  
  // convenience method.
  // calls getCellIndex and returns the corresponding (cached) cell
  // returns undefined if the cell does not exist.
  #getCell(){
    var cellIndex = this.getCellIndex.apply(this, arguments);
    var cells = this.#cells;
    var cell = cells[cellIndex];
    return cell;
  }

  getTupleRanges(ranges, previousTupleIndices, allRanges){
    var numRanges = ranges.length;

    if (!previousTupleIndices){
      allRanges = [];
      previousTupleIndices = [];
    }
    
    if (numRanges === 0) {
      allRanges.push(previousTupleIndices);
      return allRanges;
    }
    
    var tupleSets = this.#tupleSets;

    var numTupleSets = tupleSets.length;

    var tupleSetIndex = numTupleSets - numRanges;
    var tupleSet = tupleSets[tupleSetIndex];

    var range = ranges.shift();
    var fromTuple = range[0];
    var toTuple = range[1];
    
    if (fromTuple === 0 && toTuple === 0) {
      toTuple = 1;
    }
    
    for (var i = fromTuple; i < toTuple; i++){
      var rangesCopy = [].concat(ranges);

      var previousTupleIndicesCopy = [].concat(previousTupleIndices);
      previousTupleIndicesCopy.push(i);
      
      this.getTupleRanges(rangesCopy, previousTupleIndicesCopy, allRanges);
    }
    return allRanges;
  }
  
  #getValuesClauseForCellsQuery(
    dataRelationName, cellIndexColumnName, 
    tupleValueToColumnMapping, tuplesToQuery, 
    values
  ){
    var allDataPaceHoldersSql = tuplesToQuery.map(function(tuple){
      var valuesClauseRow = Object.keys(tuple).map(function(columnName){
        var value = tuple[columnName];
        if (columnName === cellIndexColumnName) {
          // we serialize the cellindex explicitly as a matter of principle: it is a value we assign,
          // whereas the tuple values are truly input values.
          // and it helps to clearly mark each tuple 
          return String(value);
        }

        if (typeof value === 'bigint'){
          // bigint values are not properly serialized by duckdb wasm 
          // see: https://github.com/duckdb/duckdb-wasm/issues/1563
          return `${String(value)}::BIGINT`;
        }

        var mappingInfo = tupleValueToColumnMapping[columnName];
        var tupleValueField = mappingInfo.tupleValueField;
        var typeName = String(tupleValueField.type);
        switch (typeName){
          case 'Timestamp<MICROSECOND>':
            // If the native duckdb is TIMESTAMP then duckdb WASM tags the field type with a custom Timestamp<MICROSECOND> class
            // The actual resultset values however are simply javascript Number primitives.
            // If we simply plug those numbers back as values to our preparedStmt.query call, it fails with the error:
            //
            // Error: Conversion Error: Unimplemented type for cast (TIMESTAMP -> DOUBLE)
            // (see: https://github.com/duckdb/duckdb-wasm/issues/1563#issuecomment-1878745744)
            //
            // now, it turns out that the number returned is the number of milliseconds since epoch, 
            // which is probably meant to make it easy to instantiate a javascript Date object with it like so:
            //
            // new Date(timestampColumnValue);
            //
            // TIMESTAMP columns have microseconds resolution and JavaScript Date's only milliseconds, 
            // but duckdb WASM deals with that by letting the number have fractional digits.
            // For example, this SQL:
            //  
            // SELECT TIMESTAMP'2024-01-05 01:02:03.456789' as ts
            //
            // results in return of this Number value: 1704416523456.7888
            // and new Date(1704416523456.7888) is 'Fri Jan 05 2024 02:02:03 GMT+0100 (Central European Standard Time)'
            //
            // However for our purpose we need to be able to use the returned JavaScript Number value to create the exact original TIMESTAMP value.
            //
            // There are two duckdb functions (see: https://duckdb.org/docs/archive/0.9.2/sql/functions/timestamp) that can help:
            //            
            // - make_timestamp(microseconds) - the microseconds is some integer value in microseconds
            // - to_timestamp(double)         - the double value is the number of *seconds* (so not microseconds or milliseconds).
            //
            // so we got milliseconds and can either multiple by 1000 to get microseconds: 
            // - make_timestamp(CAST(1704416523456.7888::DOUBLE * 1000 AS BIGINT)))
            // - to_timestamp(1704416523456.7888::DOUBLE / 1000)
            return `to_timestamp(${value}::DOUBLE / 1000)`;
          default:
        }
        values.push(value);
        return '?';
      });
      return `(${valuesClauseRow})`
    }).join('\n,');

    var columns = [cellIndexColumnName].concat(Object.keys(tupleValueToColumnMapping));
    var relationDefinition = `${dataRelationName}(${columns.map(getQuotedIdentifier).join(', ')})`;

    var valuesClause = `(VALUES ${allDataPaceHoldersSql}) AS ${relationDefinition}`;
    return valuesClause;
  }
  
  #getSqlQueryForCells(tuplesToQuery, tupleValueToColumnMapping, aggregateExpressionsToFetch, values){
    var queryModel = this.#queryModel;
    var datasource = queryModel.getDatasource();
    var qualifiedObjectName = datasource.getQualifiedObjectName();
        
    var dataRelationName = '__huey_tuples';
    var cellIndexColumnName = '__huey_cellIndex';

    aggregateExpressionsToFetch = aggregateExpressionsToFetch.map(function(expression){
      return `${expression} AS ${getQuotedIdentifier(expression)}`;
    });

    // build the SELECT list
    var quotedCellIndexColumnName = getQuotedIdentifier(cellIndexColumnName);
    var qualifiedCellIndexColumnName = getQualifiedIdentifier(dataRelationName, cellIndexColumnName);
    
    if (tuplesToQuery.length === 0){
      qualifiedCellIndexColumnName = '0';
    }
    
    var tupleIndexSelectExpression = `CAST(${qualifiedCellIndexColumnName} AS INTEGER) AS ${quotedCellIndexColumnName}`;
    var selectListExpressions = [tupleIndexSelectExpression].concat(aggregateExpressionsToFetch);
    var selectClauseSql = `SELECT ${selectListExpressions.join('\n, ')}`;
  
    var sql;
    if (tuplesToQuery.length === 0) {
      sql = `
        ${selectClauseSql}
        FROM ${qualifiedObjectName}
      `;
      return sql;
    }

    // build the FROM clause
    var valuesClause = this.#getValuesClauseForCellsQuery(
      dataRelationName, cellIndexColumnName, 
      tupleValueToColumnMapping, tuplesToQuery, 
      values
    );
    var fromClause = `FROM ${valuesClause}`;
    
    // build the JOIN clause
    var joinClause = `LEFT JOIN ${qualifiedObjectName} AS ${getQuotedIdentifier('__data')}`;
    var joinConditionsSql = Object.keys(tupleValueToColumnMapping).map(function(columnName){
      var mappingInfo = tupleValueToColumnMapping[columnName];
      var sqlExpression = mappingInfo.sqlExpression;
      var dataColumnName = getQualifiedIdentifier(dataRelationName, columnName);
      return `${dataColumnName} = ${sqlExpression}`;
    });
    var joinConditionSql = joinConditionsSql.join('\nAND ');
    var onClause = `ON ${joinConditionSql}`;
    var groupByClause = `GROUP BY ${qualifiedCellIndexColumnName}`;
    
    // build the statement
    sql = `
      ${selectClauseSql} 
      ${fromClause}
      ${joinClause}
      ${onClause}
      ${groupByClause}
    `;
    return sql;
  }
  
  async #executeCellsQuery(tuplesToQuery, tupleValueToColumnMapping, aggregateExpressionsToFetch) {
    var queryModel = this.#queryModel;
    var datasource = queryModel.getDatasource();
    var values = [];
    var sql = this.#getSqlQueryForCells(tuplesToQuery, tupleValueToColumnMapping, aggregateExpressionsToFetch, values);
    var connection = await datasource.getConnection();

    console.log(`About to create preparedStatement to fetch cell data for ${tuplesToQuery.length} tuples, SQL:`);
    console.log(sql);
    var preparedStatement = await connection.prepare(sql);
    
    console.log(`SQL to fetch cell data for ${tuplesToQuery.length} tuples prepared: ${preparedStatement.connectionId}:${preparedStatement.statementId}`);
    console.time(`Executing prepared statement ${preparedStatement.connectionId}:${preparedStatement.statementId}`);
    var resultSet = await preparedStatement.query.apply(preparedStatement, values);
    console.timeEnd(`Executing prepared statement ${preparedStatement.connectionId}:${preparedStatement.statementId}`);
    
    return resultSet;
  }
  
  #extractCellsFromResultset(resultSet){
    var cells = {};
    var fields = resultSet.schema.fields;
    for (var i = 0; i < resultSet.numRows; i++){
      var row = resultSet.get(i);
      var cellIndex, cell;
      for (var j = 0; j < fields.length; j++){
        var field = fields[j];
        var fieldName = field.name;
        if (this.#cellValueFields[fieldName] === undefined) {
          this.#cellValueFields[fieldName] = field;
        }
        var value = row[fieldName];
        
        if (j === 0) {
          cellIndex = value;
          // check if we already cached the cell, 
          // because if it already exists then we will update it with the newly fetched metrics
          cell = this.#cells[cellIndex];
          if (cell === undefined){
            // cell didn't exist! So lets add it.
            this.#cells[cellIndex] = cell = {values: {}};
          }
        }
        else {
          cell.values[fieldName] = value;
        }
      }
      cells[cellIndex] = cell;
    }
    return cells;
  }

  // ranges is aa list of tuple index pairs
  async getCells(ranges){
    var queryModel = this.#queryModel;
    var cellsAxis = queryModel.getCellsAxis();
    var cellsAxisItems = cellsAxis.getItems();
    
    if (cellsAxisItems.length === 0){
      return undefined;
    }
    
    var tupleIndices = this.getTupleRanges(ranges);
    var tupleSets = this.#tupleSets;
    var cells = this.#cells;
    
    // this is where we collect the cells, keyed by cellIndex, 
    var availableCells = {};

    // this is where we keep  the collection of values of the tuples 
    // for which we currently don't have all required cell values
    // along with the tuple values, we store the cellIndex toolbar
    // we will then use this to create an arrow table 
    var tuplesToQuery = [];
    // this is where we keep the mapping between column names of the tuple data set 
    // and the corresponding sql expressions in the main dataset.
    // we need that to correlate the filter the dataset based on the tuple data 
    var tupleValueToColumnMapping = {};
    // this is where we store the sql expressions that calculate the cell values.
    // If there are cells missing, this will contain expressions for each cells axis items
    // but if all cells were already present and just missed a particular metric, only those metric need to be calculated.
    var aggregateExpressionsToFetch = [];
            
    _combinedTuples: for (var i = 0; i < tupleIndices.length; i++){
      var tupleIndicesItem = tupleIndices[i];
      var cellIndex = this.getCellIndex.apply(this, tupleIndicesItem);
      var cell = cells[cellIndex];
      
      // make a reference to the cell which we will use to check if we need to add more aggregate sql expressions
      var cellCopy = cell;
      for (var j = 0; j < cellsAxisItems.length; j++){
        var cellsAxisItem = cellsAxisItems[j];
        var sqlExpression = QueryAxisItem.getSqlForQueryAxisItem(cellsAxisItem);
        
        if (!cellCopy || (cellCopy && cellCopy.values[sqlExpression] === undefined) ){
          // we have a cell, but the cell doesn't have a value for this axis item.
          // this means the cell is not complete so we must fetch it. 
          cell = undefined;
          
          // if we aren't already querying this aggregate, then we add it too.
          if (aggregateExpressionsToFetch.indexOf(sqlExpression) === -1) {
            aggregateExpressionsToFetch.push(sqlExpression);
          }
        }          
      }
      
      if (cell) {
        // If we arrive here, and we still have the cell, 
        // it means the cell was not only already cached, but also contains values for all currently reqyested cells axis items.
        // We can serve the cell from the cache and we don't need to include it in our SQL.
        availableCells[cellIndex] = cell;
        continue;
      }
      
      // If we arrive here, the cell is either not cached, or incomplete,
      // i.e. it lacks one or more values corresponding to the requested cells axis items. 
      // If even one cells axis item value is missing, we have to include the cell in our query.
      var row = {
        __huey_cellIndex: cellIndex
      }
      
      // for each query axis...
      _tuplesetIndices: for (var j = 0; j < tupleIndicesItem.length; j++){
                
        // ...get the tuple,...
        var tupleIndex = tupleIndicesItem[j];
        var tupleSet = tupleSets[j];
                
        var tuple = tupleSet.getTupleSync(tupleIndex);
        if (!tuple) {
          //console.error(`Couldn't find tuple ${tupleIndex} in tupleset for query axis ${tupleSet.getQueryAxisId()}`);
          continue;
        }
        var tupleValues = tuple.values;
        
        var queryAxisId = tupleSet.getQueryAxisId();
        var queryAxis = queryModel.getQueryAxis(queryAxisId);
        var queryAxisItems = queryAxis.getItems();

        for (var k = 0; k < queryAxisItems.length; k++){
          // ...and extract and store the values in our row.
          var queryAxisItem = queryAxisItems[k];
          var tupleValue = tupleValues[k];
          var columnName = `${queryAxisId}_value${k}`;
          row[columnName] = tupleValue;
          
          if (tuplesToQuery.length !== 0){
            // metadata gathered for the first tuple, not needed after that.
            continue;
          }        

          // collect metadata, only once for the entire set (done along with the first tuple)
          var tupleSetValueFields = tupleSet.getTupleValueFields();
          // store the mapping between our literal row column and the original sql expression
          var sqlExpression = QueryAxisItem.getSqlForQueryAxisItem(queryAxisItem, '__data');
          tupleValueToColumnMapping[columnName] = {
            sqlExpression: sqlExpression,
            tupleValueField: tupleSetValueFields[k]
          };
        }
      }

      // check if we gathered any tuple data
      if (Object.keys(row).length > 1) {
        // it's possible to have no tuples in case there are only cells axis items and now items on rows/columns.
        tuplesToQuery.push(row);
      }
    }
    
    if (aggregateExpressionsToFetch.length && tuplesToQuery){
      var resultset = await this.#executeCellsQuery(tuplesToQuery, tupleValueToColumnMapping, aggregateExpressionsToFetch);
      var newCells = this.#extractCellsFromResultset(resultset);
      Object.assign(availableCells, newCells);
    }
    
    return availableCells;
  }    
  
}