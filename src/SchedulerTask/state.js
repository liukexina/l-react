import * as React from "react";

class App extends React.Component {
  constructor(props) {
    super();
    this.state = {
      count: 0
    }
  }

  componentDidMount(params) {
    const button = document.querySelector('.btn')
    setTimeout( () => this.setState( { count: 1 } ), 500 )
    setTimeout( () => button.click(), 505)
  }

  handleButtonClick = () => {
    this.setState( prevState => ({ count: prevState.count + 2 }) )
  }

  render() {
    return (
      <div>
        <button className="btn" onClick={this.handleButtonClick}>
          增加2
        </button>
        <div>
        <span>{this.state.count}</span>
        </div>
      </div>
    );
  }
}

export default App;
